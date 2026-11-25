/*
 * Centralized simulated-payment service.
 *
 * All three demo methods (GCash-inspired, Maya-inspired, MariBank-inspired)
 * call the same server-side flow. The browser never supplies the amount. A
 * successful simulation records a clearly marked demo-paid purchase, enrolls
 * the learner, and unlocks the course locally. It never touches the
 * VanguardLMS billing API or counts as collected revenue.
 */
import crypto from "crypto";
import { Op } from "sequelize";
import {
  sequelize,
  Course,
  CourseEnrollment,
  CoursePurchase,
  SimulatedInvoice,
  SimulatedTransaction,
  User,
} from "../models/index.js";
import { ensureProgressRows, notify, recalcCourseProgress } from "./progressService.js";

export class SimulatedPaymentError extends Error {
  constructor(message, { status = 400, code = "simulated_payment_error" } = {}) {
    super(message);
    this.name = "SimulatedPaymentError";
    this.status = status;
    this.code = code;
  }
}

export const DEMO_METHODS = [
  {
    slug: "gcash",
    name: "GCash-inspired",
    shortName: "GCash",
    kicker: "Blue mobile wallet",
    description:
      "A familiar mobile-wallet layout. No real GCash account, MPIN, password, or OTP is requested.",
    accent: "#0a5fc7",
    accentDark: "#063a82",
    accentSoft: "#e8f2ff",
    icon: "wallet",
  },
  {
    slug: "maya",
    name: "Maya-inspired",
    shortName: "Maya",
    kicker: "Green digital wallet",
    description:
      "A clean green wallet experience. No real Maya credentials, MPIN, password, or OTP is requested.",
    accent: "#008f52",
    accentDark: "#005c36",
    accentSoft: "#e7f8ef",
    icon: "spark",
  },
  {
    slug: "maribank",
    name: "MariBank-inspired",
    shortName: "MariBank",
    kicker: "Digital banking",
    description:
      "A digital-banking inspired screen. No real banking password, PIN, OTP, or account details are collected.",
    accent: "#0f766e",
    accentDark: "#083c46",
    accentSoft: "#e8f7f5",
    icon: "bank",
  },
];

export function getDemoMethod(slug) {
  return DEMO_METHODS.find((method) => method.slug === String(slug || "").toLowerCase()) || null;
}

export function money(value) {
  const amount = Number(value);
  return Number.isFinite(amount) ? Math.round(amount * 100) / 100 : 0;
}

function makeReference(prefix) {
  const date = new Date().toISOString().slice(0, 10).replace(/-/g, "");
  return `${prefix}-${date}-${crypto.randomBytes(4).toString("hex").toUpperCase()}`;
}

export function serializeTransaction(row) {
  if (!row) return null;
  const data = row.toJSON ? row.toJSON() : row;
  const invoice = data.invoice || null;
  const method = getDemoMethod(data.paymentMethod);
  return {
    id: data.id,
    reference: data.reference,
    invoiceId: data.invoiceId,
    invoiceReference: invoice?.reference || null,
    courseId: invoice?.course?.id || null,
    paymentMethod: data.paymentMethod,
    paymentMethodName: method?.name || data.paymentMethod,
    amount: money(data.amount),
    currency: data.currency || "PHP",
    status: data.status,
    paymentMode: data.paymentMode || "demo",
    failureReason: data.failureReason || null,
    createdAt: data.createdAt,
    simulatedAt: invoice?.simulatedAt || data.createdAt,
    studentName: invoice?.user?.name || data.user?.name || null,
    studentEmail: invoice?.user?.email || data.user?.email || null,
    courseTitle: invoice?.course?.title || null,
    description: invoice?.description || null,
  };
}

export function serializeInvoice(row) {
  if (!row) return null;
  const data = row.toJSON ? row.toJSON() : row;
  return {
    id: data.id,
    reference: data.reference,
    description: data.description,
    amount: money(data.amount),
    currency: data.currency || "PHP",
    status: data.status,
    simulatedAt: data.simulatedAt || null,
    createdAt: data.createdAt,
    course: data.course
      ? {
          id: data.course.id,
          title: data.course.title,
          durationHours: data.course.durationHours,
        }
      : null,
    transaction: data.transaction ? serializeTransaction(data.transaction) : null,
  };
}

const invoiceIncludes = [
  { model: Course, as: "course", attributes: ["id", "title", "durationHours"] },
  {
    model: SimulatedTransaction,
    as: "transaction",
    required: false,
    attributes: [
      "id",
      "reference",
      "paymentMethod",
      "amount",
      "currency",
      "status",
      "paymentMode",
      "failureReason",
      "createdAt",
    ],
  },
];

async function createDemoAccessRows({ invoice, transaction, dbTransaction }) {
  const courseId = Number(invoice.courseId);
  const reference = transaction.reference;
  const amount = money(transaction.amount || invoice.amount);
  const currency = transaction.currency || invoice.currency || "PHP";
  const paidAt = invoice.simulatedAt || new Date();

  // One paid access record is enough per learner and course. Older demo data
  // can contain several simulated transactions for the same course, so reuse
  // an existing paid purchase instead of creating a duplicate for each one.
  let purchase = await CoursePurchase.findOne({
    where: { userId: transaction.userId, courseId, status: "paid" },
    transaction: dbTransaction,
  });
  let purchaseCreated = false;

  if (!purchase) {
    [purchase, purchaseCreated] = await CoursePurchase.findOrCreate({
      where: { reference },
      defaults: {
        userId: transaction.userId,
        courseId,
        amount,
        currency,
        status: "paid",
        provider: "demo",
        receiptNumber: reference,
        paidAt,
        verifiedAt: new Date(),
      },
      transaction: dbTransaction,
    });
    if (!purchaseCreated && purchase.status !== "paid") {
      await purchase.update(
        {
          status: "paid",
          amount,
          currency,
          provider: "demo",
          receiptNumber: reference,
          paidAt,
          verifiedAt: new Date(),
        },
        { transaction: dbTransaction }
      );
    }
  }

  const [enrollment, enrollmentCreated] = await CourseEnrollment.findOrCreate({
    where: { userId: transaction.userId, courseId },
    defaults: { source: "demo_purchase", status: "active" },
    transaction: dbTransaction,
  });

  return {
    userId: transaction.userId,
    courseId,
    courseTitle: invoice.course?.title || null,
    purchaseCreated,
    enrollmentCreated,
    enrollmentId: enrollment.id,
  };
}

async function finalizeDemoAccess(access) {
  if (!access) return;
  try {
    await ensureProgressRows(access.userId, access.courseId);
    await recalcCourseProgress(access.userId, access.courseId);
  } catch (error) {
    console.warn(
      `[demo] Course ${access.courseId} unlocked but progress setup failed:`,
      error.message
    );
  }

  if (access.purchaseCreated || access.enrollmentCreated) {
    await notify(access.userId, {
      title: "Demo payment complete — course unlocked",
      message: `Your simulated payment for ${access.courseTitle || "your course"} was recorded. The course is unlocked for this demo account.`,
      type: "payment",
      link: `/courses/${access.courseId}`,
    });
  }
}

/**
 * Re-apply access for a simulated transaction. This is idempotent and repairs
 * receipts created before simulated payments started unlocking courses.
 */
export async function grantDemoCourseAccess(transactionReference, userId) {
  const transaction = await SimulatedTransaction.findOne({
    where: { reference: String(transactionReference || "") },
    include: transactionIncludes,
  });
  if (
    !transaction ||
    Number(transaction.userId) !== Number(userId) ||
    transaction.status !== "simulated"
  ) {
    return null;
  }

  const invoice = transaction.invoice;
  if (!invoice?.courseId) return null;

  const access = await createDemoAccessRows({ invoice, transaction });
  await finalizeDemoAccess(access);
  return access;
}

const transactionIncludes = [
  {
    model: SimulatedInvoice,
    as: "invoice",
    required: true,
    include: [
      { model: User, as: "user", attributes: ["id", "name", "email"] },
      { model: Course, as: "course", attributes: ["id", "title"] },
    ],
  },
];

export async function eligibleDemoCourses(userId) {
  const enrolled = await CourseEnrollment.findAll({
    where: { userId },
    attributes: ["courseId"],
    raw: true,
  });
  const enrolledIds = new Set(enrolled.map((row) => Number(row.courseId)));
  const courses = await Course.findAll({
    where: { status: "published", price: { [Op.gt]: 0 } },
    attributes: ["id", "title", "price", "currency", "durationHours", "level"],
    order: [["title", "ASC"]],
  });
  const openInvoices = await SimulatedInvoice.findAll({
    where: { userId, status: "open" },
    attributes: ["courseId"],
    raw: true,
  });
  const openIds = new Set(openInvoices.map((row) => Number(row.courseId)));

  return courses
    .filter((course) => !enrolledIds.has(Number(course.id)))
    .map((course) => ({
      id: course.id,
      title: course.title,
      price: money(course.price),
      currency: course.currency || "PHP",
      durationHours: course.durationHours,
      level: course.level,
      hasOpenInvoice: openIds.has(Number(course.id)),
    }));
}

export async function getLearnerBilling(userId) {
  const [invoices, transactions, courses] = await Promise.all([
    SimulatedInvoice.findAll({
      where: { userId },
      include: invoiceIncludes,
      order: [["createdAt", "DESC"]],
    }),
    SimulatedTransaction.findAll({
      where: { userId },
      include: transactionIncludes,
      order: [["createdAt", "DESC"]],
    }),
    eligibleDemoCourses(userId),
  ]);

  const serializedInvoices = invoices.map(serializeInvoice);
  const serializedTransactions = transactions.map(serializeTransaction);
  const open = serializedInvoices.filter((invoice) => invoice.status === "open");
  const simulated = serializedTransactions.filter((row) => row.status === "simulated");

  return {
    invoices: serializedInvoices,
    transactions: serializedTransactions,
    courses,
    totals: {
      amountDue: money(open.reduce((sum, invoice) => sum + invoice.amount, 0)),
      openInvoices: open.length,
      simulatedAmount: money(simulated.reduce((sum, row) => sum + row.amount, 0)),
      simulatedCount: simulated.length,
    },
  };
}

export async function createDemoInvoice(user, courseId) {
  const id = Number(courseId);
  if (!Number.isInteger(id) || id <= 0) {
    throw new SimulatedPaymentError("Choose a valid course for the demo invoice.", {
      code: "invalid_course",
    });
  }

  const course = await Course.findOne({
    where: { id, status: "published", price: { [Op.gt]: 0 } },
  });
  if (!course) {
    throw new SimulatedPaymentError("That paid course is not available for a demo invoice.", {
      status: 404,
      code: "course_not_found",
    });
  }

  const enrolled = await CourseEnrollment.findOne({
    where: { userId: user.id, courseId: course.id },
  });
  if (enrolled) {
    throw new SimulatedPaymentError(
      "You are already enrolled in this course, so it does not need a demo invoice.",
      { status: 409, code: "already_enrolled" }
    );
  }

  const existing = await SimulatedInvoice.findOne({
    where: { userId: user.id, courseId: course.id, status: "open" },
    include: invoiceIncludes,
    order: [["createdAt", "DESC"]],
  });
  if (existing) return { invoice: serializeInvoice(existing), existing: true };

  const invoice = await SimulatedInvoice.create({
    userId: user.id,
    courseId: course.id,
    reference: makeReference("DEMO-INV"),
    description: `Course fee — ${course.title}`,
    amount: money(course.price),
    currency: course.currency || "PHP",
    status: "open",
  });

  return {
    invoice: serializeInvoice(await SimulatedInvoice.findByPk(invoice.id, { include: invoiceIncludes })),
    existing: false,
  };
}

export async function getInvoiceForLearner(reference, userId) {
  const invoice = await SimulatedInvoice.findOne({
    where: { reference: String(reference || "") },
    include: invoiceIncludes,
  });
  // A wrong owner is reported as not found so invoice references cannot be probed.
  if (!invoice || Number(invoice.userId) !== Number(userId)) {
    throw new SimulatedPaymentError("That demo invoice was not found on your account.", {
      status: 404,
      code: "invoice_not_found",
    });
  }
  return invoice;
}

/**
 * Record a demo transaction. `submittedAmount` is accepted only for audit
 * comparison; the stored amount always comes from the invoice row.
 */
export async function simulatePayment({ user, invoiceReference, methodSlug, submittedAmount }) {
  const method = getDemoMethod(methodSlug);
  if (!method) {
    throw new SimulatedPaymentError("Choose one of the available demo payment methods.", {
      code: "invalid_payment_method",
    });
  }

  let outcome;
  try {
    outcome = await sequelize.transaction(async (dbTransaction) => {
      const invoice = await SimulatedInvoice.findOne({
        where: { reference: String(invoiceReference || "") },
        include: [{ model: Course, as: "course" }],
        transaction: dbTransaction,
        lock: dbTransaction.LOCK.UPDATE,
      });
      if (!invoice || Number(invoice.userId) !== Number(user.id)) {
        throw new SimulatedPaymentError("That demo invoice was not found on your account.", {
          status: 404,
          code: "invoice_not_found",
        });
      }

      const existing = await SimulatedTransaction.findOne({
        where: { invoiceId: invoice.id },
        include: transactionIncludes,
        transaction: dbTransaction,
      });
      if (existing) {
        return { duplicate: true, transaction: serializeTransaction(existing), invoice: serializeInvoice(invoice) };
      }

      if (invoice.status !== "open") {
        throw new SimulatedPaymentError(
          "This demo invoice is no longer open for payment.",
          { status: 409, code: "invoice_not_open" }
        );
      }

      // Never read the amount from the request body.
      const amount = money(invoice.amount);
      if (amount <= 0) {
        throw new SimulatedPaymentError("The demo invoice has no payable amount.", {
          status: 409,
          code: "invoice_amount_invalid",
        });
      }

      const transactionRow = await SimulatedTransaction.create(
        {
          userId: user.id,
          invoiceId: invoice.id,
          reference: makeReference("DEMO-TXN"),
          paymentMethod: method.slug,
          amount,
          currency: invoice.currency || "PHP",
          status: "simulated",
          paymentMode: "demo",
        },
        { transaction: dbTransaction }
      );

      await invoice.update(
        { status: "simulated", simulatedAt: new Date() },
        { transaction: dbTransaction }
      );

      const access = await createDemoAccessRows({
        invoice,
        transaction: transactionRow,
        dbTransaction,
      });

      const saved = await SimulatedTransaction.findByPk(transactionRow.id, {
        include: transactionIncludes,
        transaction: dbTransaction,
      });
      await invoice.reload({ include: invoiceIncludes, transaction: dbTransaction });

      return {
        duplicate: false,
        transaction: serializeTransaction(saved),
        invoice: serializeInvoice(invoice),
        access,
        submittedAmountIgnored:
          submittedAmount !== undefined &&
          submittedAmount !== null &&
          String(submittedAmount) !== "" &&
          money(submittedAmount) !== amount,
      };
    });
  } catch (error) {
    // A race between two submissions loses on the unique invoiceId index.
    if (error?.name === "SequelizeUniqueConstraintError") {
      const invoice = await SimulatedInvoice.findOne({
        where: { reference: String(invoiceReference || ""), userId: user.id },
        attributes: ["id"],
      });
      const existing = invoice
        ? await SimulatedTransaction.findOne({
            where: { invoiceId: invoice.id },
            include: transactionIncludes,
          })
        : null;
      if (existing) {
        const access = await grantDemoCourseAccess(existing.reference, user.id);
        return { duplicate: true, transaction: serializeTransaction(existing), invoice: null, access };
      }
    }
    throw error;
  }

  if (outcome.access) {
    await finalizeDemoAccess(outcome.access);
  } else if (outcome.duplicate && outcome.transaction?.status === "simulated") {
    outcome.access = await grantDemoCourseAccess(outcome.transaction.reference, user.id);
  }

  return outcome;
}

export async function cancelDemoPayment({ user, invoiceReference, methodSlug }) {
  const method = getDemoMethod(methodSlug);
  if (!method) {
    throw new SimulatedPaymentError("Choose one of the available demo payment methods.", {
      code: "invalid_payment_method",
    });
  }

  return sequelize.transaction(async (dbTransaction) => {
    const invoice = await SimulatedInvoice.findOne({
      where: { reference: String(invoiceReference || "") },
      transaction: dbTransaction,
      lock: dbTransaction.LOCK.UPDATE,
    });
    if (!invoice || Number(invoice.userId) !== Number(user.id)) {
      throw new SimulatedPaymentError("That demo invoice was not found on your account.", {
        status: 404,
        code: "invoice_not_found",
      });
    }

    const existing = await SimulatedTransaction.findOne({
      where: { invoiceId: invoice.id },
      include: transactionIncludes,
      transaction: dbTransaction,
    });
    if (existing) {
      return { duplicate: true, transaction: serializeTransaction(existing) };
    }
    if (invoice.status !== "open") {
      throw new SimulatedPaymentError("This demo invoice is no longer open.", {
        status: 409,
        code: "invoice_not_open",
      });
    }

    const transactionRow = await SimulatedTransaction.create(
      {
        userId: user.id,
        invoiceId: invoice.id,
        reference: makeReference("DEMO-TXN"),
        paymentMethod: method.slug,
        amount: money(invoice.amount),
        currency: invoice.currency || "PHP",
        status: "cancelled",
        paymentMode: "demo",
        failureReason: "Cancelled by the learner before the simulation was completed.",
      },
      { transaction: dbTransaction }
    );
    await invoice.update({ status: "cancelled" }, { transaction: dbTransaction });
    const saved = await SimulatedTransaction.findByPk(transactionRow.id, {
      include: transactionIncludes,
      transaction: dbTransaction,
    });
    return { duplicate: false, transaction: serializeTransaction(saved) };
  });
}

export async function failDemoPayment({ user, invoiceReference, methodSlug }) {
  const method = getDemoMethod(methodSlug);
  if (!method) {
    throw new SimulatedPaymentError("Choose one of the available demo payment methods.", {
      code: "invalid_payment_method",
    });
  }

  return sequelize.transaction(async (dbTransaction) => {
    const invoice = await SimulatedInvoice.findOne({
      where: { reference: String(invoiceReference || "") },
      transaction: dbTransaction,
      lock: dbTransaction.LOCK.UPDATE,
    });
    if (!invoice || Number(invoice.userId) !== Number(user.id)) {
      throw new SimulatedPaymentError("That demo invoice was not found on your account.", {
        status: 404,
        code: "invoice_not_found",
      });
    }

    const existing = await SimulatedTransaction.findOne({
      where: { invoiceId: invoice.id },
      include: transactionIncludes,
      transaction: dbTransaction,
    });
    if (existing) {
      return { duplicate: true, transaction: serializeTransaction(existing) };
    }
    if (invoice.status !== "open") {
      throw new SimulatedPaymentError("This demo invoice is no longer open.", {
        status: 409,
        code: "invoice_not_open",
      });
    }

    const transactionRow = await SimulatedTransaction.create(
      {
        userId: user.id,
        invoiceId: invoice.id,
        reference: makeReference("DEMO-TXN"),
        paymentMethod: method.slug,
        amount: money(invoice.amount),
        currency: invoice.currency || "PHP",
        status: "failed",
        paymentMode: "demo",
        failureReason: "Failure deliberately simulated from the demo payment screen.",
      },
      { transaction: dbTransaction }
    );
    await invoice.update({ status: "failed" }, { transaction: dbTransaction });
    const saved = await SimulatedTransaction.findByPk(transactionRow.id, {
      include: transactionIncludes,
      transaction: dbTransaction,
    });
    return { duplicate: false, transaction: serializeTransaction(saved) };
  });
}

export async function getTransactionForLearner(reference, userId) {
  const row = await SimulatedTransaction.findOne({
    where: { reference: String(reference || "") },
    include: transactionIncludes,
  });
  if (!row || Number(row.userId) !== Number(userId)) {
    throw new SimulatedPaymentError("That demo transaction was not found on your account.", {
      status: 404,
      code: "transaction_not_found",
    });
  }
  return serializeTransaction(row);
}

/* ------------------------------------------------------------------ admin */

export async function listDemoTransactions(filters = {}, { limit = 200 } = {}) {
  const q = String(filters.q || "").trim().toLowerCase();
  const method = String(filters.method || "").trim();
  const status = String(filters.status || "").trim();

  const rows = await SimulatedTransaction.findAll({
    include: transactionIncludes,
    order: [["createdAt", "DESC"]],
    limit: 5000,
  });

  const filtered = rows.map(serializeTransaction).filter((row) => {
    if (method && row.paymentMethod !== method) return false;
    if (status && row.status !== status) return false;
    if (!q) return true;
    return [row.reference, row.invoiceReference, row.studentName, row.studentEmail, row.courseTitle]
      .filter(Boolean)
      .some((value) => String(value).toLowerCase().includes(q));
  });

  const simulated = filtered.filter((row) => row.status === "simulated");
  return {
    rows: filtered.slice(0, limit),
    total: filtered.length,
    totals: {
      simulatedCount: simulated.length,
      simulatedAmount: money(simulated.reduce((sum, row) => sum + row.amount, 0)),
      cancelledCount: filtered.filter((row) => row.status === "cancelled").length,
      failedCount: filtered.filter((row) => row.status === "failed").length,
    },
  };
}

export async function getDemoTransactionForAdmin(reference) {
  const row = await SimulatedTransaction.findOne({
    where: { reference: String(reference || "") },
    include: transactionIncludes,
  });
  if (!row) {
    throw new SimulatedPaymentError("That demo transaction does not exist.", {
      status: 404,
      code: "transaction_not_found",
    });
  }
  const invoice = await SimulatedInvoice.findByPk(row.invoiceId, {
    include: [{ model: Course, as: "course", attributes: ["id", "title"] }],
  });
  return {
    transaction: serializeTransaction(row),
    invoice: serializeInvoice(invoice),
  };
}

export async function demoTransactionCsv(filters = {}) {
  const { rows } = await listDemoTransactions(filters, { limit: 5000 });
  const escape = (value) => {
    const text = String(value ?? "");
    return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  };
  const header = [
    "transaction_reference",
    "invoice_reference",
    "student_name",
    "student_email",
    "course",
    "payment_method",
    "amount",
    "currency",
    "status",
    "payment_mode",
    "created_at",
  ];
  const lines = rows.map((row) =>
    [
      row.reference,
      row.invoiceReference,
      row.studentName,
      row.studentEmail,
      row.courseTitle,
      row.paymentMethodName,
      row.amount.toFixed(2),
      row.currency,
      row.status,
      row.paymentMode,
      row.createdAt ? new Date(row.createdAt).toISOString() : "",
    ]
      .map(escape)
      .join(",")
  );
  return [header.join(","), ...lines].join("\n");
}
