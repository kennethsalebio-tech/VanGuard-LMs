/*
 * Learner and administrator pages for the clearly labeled demo payment module.
 * Real course checkout remains in financeController.js and is not touched here.
 */
import { logActivity } from "../middleware/auth.js";
import {
  SimulatedPaymentError,
  cancelDemoPayment,
  createDemoInvoice,
  demoTransactionCsv,
  DEMO_METHODS,
  failDemoPayment,
  getDemoMethod,
  getDemoTransactionForAdmin,
  getInvoiceForLearner,
  getLearnerBilling,
  getTransactionForLearner,
  listDemoTransactions,
  serializeInvoice,
  simulatePayment,
} from "../services/simulatedPaymentService.js";

function pageError(req, res, error, fallback = "/billing") {
  if (error instanceof SimulatedPaymentError) {
    req.flash("error_msg", error.message);
    return res.redirect(fallback);
  }
  throw error;
}

export async function billingDashboardPage(req, res) {
  const data = await getLearnerBilling(req.user.id);
  return res.render("billing", {
    title: "Billing · Demo payments",
    data,
    demoMethods: DEMO_METHODS,
  });
}

export async function createDemoInvoiceAction(req, res) {
  try {
    const result = await createDemoInvoice(req.user, req.body?.courseId);
    if (!result.existing) {
      await logActivity(req, "Created simulated invoice", {
        entityType: "simulated_invoice",
        entityId: result.invoice.id,
        detail: `${result.invoice.reference} · ${result.invoice.course?.title || "Course"} · PHP ${result.invoice.amount.toFixed(2)}`,
      });
    }
    req.flash(
      result.existing ? "info_msg" : "success_msg",
      result.existing
        ? "An open demo invoice already exists for that course."
        : `Demo invoice ${result.invoice.reference} is ready. It is not a real bill.`
    );
    return res.redirect(`/billing/invoices/${encodeURIComponent(result.invoice.reference)}`);
  } catch (error) {
    return pageError(req, res, error, "/billing");
  }
}

export async function paymentMethodsPage(req, res) {
  try {
    const invoice = await getInvoiceForLearner(req.params.reference, req.user.id);
    if (invoice.transaction) {
      return res.redirect(`/billing/transactions/${encodeURIComponent(invoice.transaction.reference)}`);
    }
    if (invoice.status !== "open") {
      req.flash("info_msg", "That demo invoice is no longer open.");
      return res.redirect("/billing");
    }
    return res.render("billing-payment-methods", {
      title: "Choose demo payment method",
      invoice: serializeInvoice(invoice),
      demoMethods: DEMO_METHODS,
    });
  } catch (error) {
    return pageError(req, res, error, "/billing");
  }
}

export async function paymentMethodPage(req, res) {
  const method = getDemoMethod(req.params.method);
  if (!method) {
    req.flash("error_msg", "That demo payment method is not available.");
    return res.redirect("/billing");
  }

  try {
    const invoice = await getInvoiceForLearner(req.params.reference, req.user.id);
    if (invoice.transaction) {
      return res.redirect(`/billing/transactions/${encodeURIComponent(invoice.transaction.reference)}`);
    }
    if (invoice.status !== "open") {
      req.flash("info_msg", "That demo invoice is no longer open.");
      return res.redirect("/billing");
    }
    return res.render("billing-payment", {
      title: `${method.name} demo`,
      invoice: serializeInvoice(invoice),
      method,
      student: req.user,
    });
  } catch (error) {
    return pageError(req, res, error, "/billing");
  }
}

export async function simulatePaymentAction(req, res) {
  const method = getDemoMethod(req.params.method);
  if (!method) {
    req.flash("error_msg", "That demo payment method is not available.");
    return res.redirect("/billing");
  }

  try {
    const result = await simulatePayment({
      user: req.user,
      invoiceReference: req.params.reference,
      methodSlug: method.slug,
      submittedAmount: req.body?.amount,
    });

    if (!result.duplicate) {
      await logActivity(req, "Recorded simulated payment", {
        entityType: "simulated_transaction",
        entityId: result.transaction.id,
        detail: `${result.transaction.reference} · ${method.name} · invoice ${result.transaction.invoiceReference} · PHP ${result.transaction.amount.toFixed(2)}${result.submittedAmountIgnored ? " · client amount ignored" : ""}`,
      });
      req.flash("success_msg", "Demo payment simulated. No real money moved.");
    } else {
      req.flash("info_msg", "This demo invoice already has a transaction; showing the existing result.");
    }
    return res.redirect(`/billing/transactions/${encodeURIComponent(result.transaction.reference)}`);
  } catch (error) {
    if (error instanceof SimulatedPaymentError) {
      req.flash("error_msg", error.message);
      return res.redirect(`/billing/invoices/${encodeURIComponent(req.params.reference)}`);
    }
    throw error;
  }
}

export async function cancelPaymentAction(req, res) {
  const method = getDemoMethod(req.body?.method);
  if (!method) {
    req.flash("error_msg", "That demo payment method is not available.");
    return res.redirect("/billing");
  }

  try {
    const result = await cancelDemoPayment({
      user: req.user,
      invoiceReference: req.params.reference,
      methodSlug: method.slug,
    });
    if (!result.duplicate) {
      await logActivity(req, "Cancelled simulated payment", {
        entityType: "simulated_transaction",
        entityId: result.transaction.id,
        detail: `${result.transaction.reference} · ${method.name} · invoice ${result.transaction.invoiceReference}`,
      });
      req.flash("info_msg", "Demo payment cancelled. No real money moved.");
    }
    return res.redirect(`/billing/transactions/${encodeURIComponent(result.transaction.reference)}`);
  } catch (error) {
    if (error instanceof SimulatedPaymentError) {
      req.flash("error_msg", error.message);
      return res.redirect(`/billing/invoices/${encodeURIComponent(req.params.reference)}`);
    }
    throw error;
  }
}

export async function failPaymentAction(req, res) {
  const method = getDemoMethod(req.body?.method);
  if (!method) {
    req.flash("error_msg", "That demo payment method is not available.");
    return res.redirect("/billing");
  }

  try {
    const result = await failDemoPayment({
      user: req.user,
      invoiceReference: req.params.reference,
      methodSlug: method.slug,
    });
    if (!result.duplicate) {
      await logActivity(req, "Recorded failed payment simulation", {
        entityType: "simulated_transaction",
        entityId: result.transaction.id,
        detail: `${result.transaction.reference} · ${method.name} · invoice ${result.transaction.invoiceReference}`,
      });
      req.flash("info_msg", "Failure simulated. No real money moved.");
    }
    return res.redirect(`/billing/transactions/${encodeURIComponent(result.transaction.reference)}`);
  } catch (error) {
    if (error instanceof SimulatedPaymentError) {
      req.flash("error_msg", error.message);
      return res.redirect(`/billing/invoices/${encodeURIComponent(req.params.reference)}`);
    }
    throw error;
  }
}

export async function paymentResultPage(req, res) {
  try {
    const transaction = await getTransactionForLearner(req.params.reference, req.user.id);
    return res.render("billing-result", {
      title:
        transaction.status === "simulated"
          ? "Simulated payment successful"
          : transaction.status === "cancelled"
            ? "Simulation cancelled"
            : "Simulation failed",
      transaction,
      method: getDemoMethod(transaction.paymentMethod),
    });
  } catch (error) {
    return pageError(req, res, error, "/billing");
  }
}

/* ------------------------------------------------------------------ admin */

function adminFilters(query) {
  return {
    q: String(query.q || "").trim(),
    method: String(query.method || "").trim(),
    status: String(query.status || "").trim(),
  };
}

export async function adminDemoPaymentsPage(req, res) {
  const filters = adminFilters(req.query);
  const data = await listDemoTransactions(filters);
  const params = new URLSearchParams();
  for (const key of ["q", "method", "status"]) {
    if (filters[key]) params.set(key, filters[key]);
  }
  return res.render("admin/simulated-payments", {
    title: "Simulated payments",
    data,
    filters,
    exportUrl: `/admin/finance/simulated/export${params.size ? `?${params.toString()}` : ""}`,
    demoMethods: DEMO_METHODS,
  });
}

export async function adminDemoPaymentDetailPage(req, res) {
  try {
    const data = await getDemoTransactionForAdmin(req.params.reference);
    return res.render("admin/simulated-payment-detail", {
      title: `Demo ${data.transaction.reference}`,
      ...data,
      method: getDemoMethod(data.transaction.paymentMethod),
    });
  } catch (error) {
    if (error instanceof SimulatedPaymentError) {
      req.flash("error_msg", error.message);
      return res.redirect("/admin/finance/simulated");
    }
    throw error;
  }
}

export async function adminDemoPaymentsExport(req, res) {
  const csv = await demoTransactionCsv(adminFilters(req.query));
  const date = new Date().toISOString().slice(0, 10);
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader(
    "Content-Disposition",
    `attachment; filename="demo-payments-${date}.csv"`
  );
  res.setHeader("Cache-Control", "no-store");
  return res.send(csv);
}
