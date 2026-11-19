/*
 * Billing & finance persistence.
 *
 * LMS_IND is the source of truth for learners, instructors and course content.
 * This database therefore stores a *mirror* of the price catalogue plus the
 * financial records (transactions, receipts, refunds) that VanguardLMS owns.
 * No learner accounts and no course content are duplicated here: only the
 * stable LMS course id and the display fields needed on a receipt.
 */
import { DataTypes } from "sequelize";
import { sequelize } from "./db.js";

export const TRANSACTION_STATUSES = [
  "pending",
  "paid",
  "failed",
  "cancelled",
  "refunded",
];

export const BillingCourse = sequelize.define(
  "BillingCourse",
  {
    // LMS_IND Courses.id — the stable cross-system identifier.
    courseId: { type: DataTypes.INTEGER, allowNull: false, unique: true },
    title: { type: DataTypes.STRING, allowNull: false },
    instructorName: { type: DataTypes.STRING },
    price: { type: DataTypes.DECIMAL(10, 2), allowNull: false, defaultValue: 0 },
    currency: { type: DataTypes.STRING, allowNull: false, defaultValue: "PHP" },
    status: {
      type: DataTypes.ENUM("free", "paid", "archived"),
      allowNull: false,
      defaultValue: "paid",
    },
    syncedAt: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
  },
  { indexes: [{ unique: true, fields: ["courseId"] }] }
);

export const BillingTransaction = sequelize.define(
  "BillingTransaction",
  {
    // Unguessable public reference used in checkout/receipt URLs.
    reference: { type: DataTypes.STRING(64), allowNull: false, unique: true },
    // Lets LMS retry a checkout without creating a second pending payment.
    idempotencyKey: { type: DataTypes.STRING(128), allowNull: true, unique: true },
    learnerId: { type: DataTypes.INTEGER, allowNull: false },
    learnerName: { type: DataTypes.STRING, allowNull: false },
    learnerEmail: { type: DataTypes.STRING, allowNull: false },
    courseId: { type: DataTypes.INTEGER, allowNull: false },
    courseTitle: { type: DataTypes.STRING, allowNull: false },
    amount: { type: DataTypes.DECIMAL(10, 2), allowNull: false },
    currency: { type: DataTypes.STRING, allowNull: false, defaultValue: "PHP" },
    status: {
      type: DataTypes.ENUM(...TRANSACTION_STATUSES),
      allowNull: false,
      defaultValue: "pending",
    },
    provider: {
      type: DataTypes.ENUM("sandbox", "hitpay", "paypal", "gcash", "card"),
      allowNull: false,
      defaultValue: "sandbox",
    },
    paymentMethod: { type: DataTypes.STRING, allowNull: false, defaultValue: "Test checkout" },
    receiptNumber: { type: DataTypes.STRING(64), allowNull: true, unique: true },
    paidAt: { type: DataTypes.DATE, allowNull: true },
    verifiedAt: { type: DataTypes.DATE, allowNull: true },
    failedAt: { type: DataTypes.DATE, allowNull: true },
    refundedAt: { type: DataTypes.DATE, allowNull: true },
    refundAmount: { type: DataTypes.DECIMAL(10, 2), allowNull: true },
    refundReason: { type: DataTypes.STRING, allowNull: true },
    // HitPay payment-request id (safe to store; it is not a secret).
    providerReference: { type: DataTypes.STRING },
    // HitPay charge/payment id required by the refund API.
    providerPaymentId: { type: DataTypes.STRING },
    providerCheckoutUrl: { type: DataTypes.TEXT },
    providerStatus: { type: DataTypes.STRING(32) },
    providerExpiresAt: { type: DataTypes.DATE, allowNull: true },
    failureReason: { type: DataTypes.STRING(255) },
    lastEventAt: { type: DataTypes.DATE, allowNull: true },
  },
  {
    indexes: [
      { unique: true, fields: ["reference"] },
      { fields: ["learnerId", "courseId"] },
      { fields: ["status", "createdAt"] },
      { fields: ["providerReference"] },
      { fields: ["providerPaymentId"] },
    ],
  }
);

/*
 * Every provider callback is recorded by its provider event id. The unique
 * index is the idempotency guard: a replayed webhook cannot change a payment
 * twice or issue a second receipt.
 */
export const BillingEvent = sequelize.define(
  "BillingEvent",
  {
    eventId: { type: DataTypes.STRING(128), allowNull: false, unique: true },
    reference: { type: DataTypes.STRING(64) },
    type: { type: DataTypes.STRING, allowNull: false },
    source: { type: DataTypes.STRING, allowNull: false, defaultValue: "provider" },
    payload: { type: DataTypes.TEXT },
  },
  { indexes: [{ unique: true, fields: ["eventId"] }] }
);
