/*
 * Finance & Billing pages for LMS_IND.
 *
 * Every figure rendered here comes from the VanguardLMS billing API. When the
 * service is unreachable the pages render an explicit connection error with a
 * retry link — never placeholder or sample numbers.
 */
import { Course } from "../models/index.js";
import { logActivity } from "../middleware/auth.js";
import { billing, BillingError } from "../services/billingClient.js";
import {
  courseIsPaid,
  findPurchase,
  money,
  refreshPurchase,
  serializePurchase,
  syncCourseToBilling,
} from "../services/financeService.js";
import {
  createDemoInvoice,
  SimulatedPaymentError,
} from "../services/simulatedPaymentService.js";

function errorView(error) {
  return {
    unavailable: true,
    message:
      error instanceof BillingError && error.unavailable
        ? "The Finance & Billing service is temporarily unavailable. Existing LMS features are unaffected."
        : error.message || "The billing service returned an error.",
    code: error.code || "billing_error",
    status: error.status || 0,
  };
}

/* --------------------------------------------------------------- dashboard */

export async function financeDashboardPage(req, res) {
  try {
    const [data, revenue] = await Promise.all([billing.dashboard(), billing.revenue(6)]);
    return res.render("admin/finance", {
      title: "Finance & Billing",
      data,
      revenue,
      error: null,
      active: "dashboard",
    });
  } catch (error) {
    console.error("[finance] Dashboard unavailable:", error.message);
    return res.render("admin/finance", {
      title: "Finance & Billing",
      data: null,
      revenue: null,
      error: errorView(error),
      active: "dashboard",
    });
  }
}

export async function financeTransactionsPage(req, res) {
  const query = {
    search: req.query.search,
    status: req.query.status,
    courseId: req.query.courseId,
    from: req.query.from,
    to: req.query.to,
    page: req.query.page,
    perPage: req.query.perPage,
    sort: req.query.sort,
    dir: req.query.dir,
  };

  try {
    const data = await billing.transactions(query);
    const courses = await billing
      .courses()
      .then((result) => result.items || [])
      .catch(() => []);
    return res.render("admin/finance-transactions", {
      title: "Transactions",
      data,
      query,
      courses,
      links: transactionLinks(query, data.pagination, data.sort),
      error: null,
    });
  } catch (error) {
    console.error("[finance] Transactions unavailable:", error.message);
    return res.render("admin/finance-transactions", {
      title: "Transactions",
      data: null,
      query,
      courses: [],
      links: null,
      error: errorView(error),
    });
  }
}

/* Stable query-string links for sorting and pagination. */
function transactionLinks(query, pagination, sort) {
  const build = (overrides = {}) => {
    const params = new URLSearchParams();
    const merged = { ...query, ...overrides };
    for (const key of ["search", "status", "courseId", "from", "to", "sort", "dir", "perPage", "page"]) {
      const value = merged[key];
      if (value !== undefined && value !== null && String(value) !== "") {
        params.set(key, String(value));
      }
    }
    return `?${params.toString()}`;
  };

  const sortLink = (column) =>
    build({
      sort: column,
      dir: sort.column === column && sort.dir === "asc" ? "desc" : "asc",
      page: 1,
    });

  return {
    sort: {
      createdAt: sortLink("createdAt"),
      learnerName: sortLink("learnerName"),
      courseTitle: sortLink("courseTitle"),
      amount: sortLink("amount"),
      status: sortLink("status"),
    },
    prev: pagination.page > 1 ? build({ page: pagination.page - 1 }) : null,
    next: pagination.page < pagination.pages ? build({ page: pagination.page + 1 }) : null,
    receiptBase: "/admin/finance/receipts/",
  };
}

export async function financeReceiptPage(req, res) {
  try {
    const receipt = await billing.receipt(req.params.reference);
    return res.render("admin/receipt", {
      title: `Receipt ${receipt.receiptNumber}`,
      receipt,
      error: null,
    });
  } catch (error) {
    if (error.status === 404) {
      req.flash("error_msg", "That receipt does not exist or the payment is not paid yet.");
      return res.redirect("/admin/finance/transactions");
    }
    console.error("[finance] Receipt unavailable:", error.message);
    return res.status(503).render("admin/receipt", {
      title: "Receipt unavailable",
      receipt: null,
      error: errorView(error),
    });
  }
}

export async function financeRefundAction(req, res) {
  const reference = req.params.reference;
  try {
    await billing.refund(reference, {
      amount: req.body?.amount ? Number(req.body.amount) : undefined,
      reason: String(req.body?.reason || "Refund requested by administrator").slice(0, 250),
    });
    // Keep the learner-side ledger in step with the billing decision.
    const local = await findPurchase(reference);
    if (local && local.status === "paid") {
      await local.update({ status: "refunded", refundedAt: new Date() });
    }
    await logActivity(req, "Issued course refund", {
      entityType: "payment",
      detail: `Reference ${reference}`,
    });
    req.flash("success_msg", `Refund recorded for ${reference}.`);
  } catch (error) {
    console.error("[finance] Refund failed:", error.message);
    req.flash(
      "error_msg",
      error instanceof BillingError && error.unavailable
        ? "The billing service is unreachable, so the refund was not recorded."
        : error.message || "The refund could not be recorded."
    );
  }
  return res.redirect(req.get("referer") || "/admin/finance/transactions");
}

/* ------------------------------------------------------------ course price */

export async function updateCoursePrice(req, res) {
  const course = await Course.findByPk(req.params.id, {
    include: [{ association: "instructor" }],
  });
  if (!course) {
    req.flash("error_msg", "That course does not exist.");
    return res.redirect("/admin/courses");
  }

  const raw = String(req.body?.price ?? "").replace(/[^\d.]/g, "");
  const price = money(raw || 0);
  if (!Number.isFinite(price) || price < 0 || price > 1000000) {
    req.flash("error_msg", "Enter a course price between 0 and 1,000,000.");
    return res.redirect("/admin/courses");
  }

  const wasPaid = courseIsPaid(course);
  await course.update({ price, currency: "PHP" });

  // Mirror the new price into the billing catalogue; a billing outage must not
  // block course management, so the result is reported rather than thrown.
  const sync = await syncCourseToBilling(course);

  await logActivity(req, price > 0 ? "Set course price" : "Made course free", {
    entityType: "course",
    entityId: course.id,
    detail: `${course.title} · ${price > 0 ? `PHP ${price.toFixed(2)}` : "Free"}`,
  });

  const notes = [];
  if (price > 0) notes.push(`${course.title} is now PAID at PHP ${price.toFixed(2)}.`);
  else notes.push(`${course.title} is now FREE.`);
  if (!sync.synced) notes.push("The billing service could not be updated yet — set the price again once it is reachable.");
  if (wasPaid && price === 0) notes.push("Existing paid enrollments are kept.");

  req.flash(sync.synced ? "success_msg" : "error_msg", notes.join(" "));
  return res.redirect("/admin/courses");
}

/* --------------------------------------------------------------- purchase */

export async function purchaseCourse(req, res) {
  const course = await Course.findOne({
    where: { id: req.params.id, status: "published" },
    include: [{ association: "instructor" }, { association: "category" }],
  });
  if (!course) {
    req.flash("error_msg", "That course is not available for purchase.");
    return res.redirect("/courses");
  }
  if (!courseIsPaid(course)) {
    req.flash("info_msg", "This course is free — use Enroll instead.");
    return res.redirect(`/courses/${course.id}`);
  }

  try {
    // The learner purchase flow uses the demo ledger. createDemoInvoice reads
    // the course price server-side, checks ownership/access, and returns any
    // existing open invoice instead of creating a duplicate.
    const result = await createDemoInvoice(req.user, course.id);

    if (!result.existing) {
      await logActivity(req, "Created simulated invoice", {
        entityType: "simulated_invoice",
        entityId: result.invoice.id,
        detail: `${result.invoice.reference} · ${course.title} · PHP ${Number(result.invoice.amount).toFixed(2)}`,
      });
    }

    req.flash(
      result.existing ? "info_msg" : "success_msg",
      result.existing
        ? "Resuming your pending demo invoice."
        : `Demo invoice ${result.invoice.reference} is ready. It is not a real bill.`
    );
    return res.redirect(
      `/billing/invoices/${encodeURIComponent(result.invoice.reference)}`
    );
  } catch (error) {
    if (error instanceof SimulatedPaymentError) {
      req.flash("error_msg", error.message);
      return res.redirect(`/courses/${course.id}`);
    }
    console.error("[finance] Purchase failed:", error.message);
    req.flash("error_msg", "The demo checkout could not be started. Please try again.");
    return res.redirect(`/courses/${course.id}`);
  }
}

export async function purchaseStatusPage(req, res) {
  const course = await Course.findByPk(req.params.id, {
    include: [{ association: "instructor" }, { association: "category" }],
  });
  if (!course) {
    req.flash("error_msg", "That course does not exist.");
    return res.redirect("/courses");
  }

  const local = await findPurchase(req.params.reference);
  if (!local || local.courseId !== course.id || local.userId !== req.user.id) {
    req.flash("error_msg", "We could not find that purchase on your account.");
    return res.redirect(`/courses/${course.id}`);
  }

  try {
    const result = await refreshPurchase(req.params.reference, { user: req.user });
    return res.render("purchase-status", {
      title: "Purchase status",
      course,
      purchase: serializePurchase(result.purchase || local),
      payment: result.payment,
      error: null,
    });
  } catch (error) {
    console.error("[finance] Purchase status unavailable:", error.message);
    return res.render("purchase-status", {
      title: "Purchase status",
      course,
      purchase: serializePurchase(local),
      payment: null,
      error: errorView(error),
    });
  }
}

/* ---------------------------------------------------------------- webhook */

export async function billingWebhook(req, res) {
  const { verifyWebhookSignature, handleBillingWebhook } = await import(
    "../services/financeService.js"
  );

  const valid = verifyWebhookSignature({
    rawBody: req.rawBody || "",
    timestamp: req.get("x-lms-timestamp"),
    signature: req.get("x-lms-signature"),
  });
  if (!valid) {
    console.warn("[finance] Rejected unsigned billing webhook.");
    return res.status(401).json({ error: "invalid_signature" });
  }

  try {
    const body = req.body || {};
    const result = await handleBillingWebhook(body);
    return res.json({ ok: true, ...result });
  } catch (error) {
    console.error("[finance] Webhook handling failed:", error.message);
    // 5xx makes the billing service retry; fulfilment stays idempotent.
    return res.status(503).json({ error: "webhook_processing_failed" });
  }
}
