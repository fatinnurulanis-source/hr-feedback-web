require("dotenv").config();

const express = require("express");
const path = require("path");
const session = require("express-session");
const PDFDocument = require("pdfkit");
const { db, auth } = require("./config/firebase");

const app = express();
const PORT = process.env.PORT || 3000;

// EJS setup
app.set("view engine", "ejs");
app.set("views", path.join(__dirname, "views"));

// Middleware
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

// Session
app.use(
  session({
    secret:
      process.env.SESSION_SECRET ||
      "local-development-secret",

    resave: false,
    saveUninitialized: false,

    cookie: {
      httpOnly: true,
      maxAge: 1000 * 60 * 60 * 2,
    },
  })
);

// Protect HR pages
function requireHR(req, res, next) {
  if (!req.session.user) {
    return res.redirect("/login");
  }

  const role = String(
    req.session.user.role || ""
  )
    .trim()
    .toLowerCase();

  if (role !== "hr") {
    return res
      .status(403)
      .send("Access denied.");
  }

  return next();
}

// Normalize feedback status
function normalizeStatus(status) {
  return String(status || "")
    .trim()
    .toLowerCase();
}

// Display employee name
function getSubmittedBy(feedback) {
  if (feedback.is_anonymous === true) {
    return "Anonymous";
  }

  return feedback.submitted_by || "-";
}

// Get feedback category
function getCategory(feedback) {
  return (
    String(
      feedback.category ||
      feedback.title ||
      "Other"
    ).trim() || "Other"
  );
}

// Get responsible department
function getDepartment(feedback) {
  return (
    String(
      feedback.department ||
      feedback.responsible_department ||
      "Other"
    ).trim() || "Other"
  );
}

// Get feedback details
function getFeedbackDetails(feedback) {
  return (
    feedback.message ||
    feedback.description ||
    "No feedback details provided."
  );
}

// Format Firestore date
function formatDate(value) {
  if (!value) {
    return "-";
  }

  let date;

  if (typeof value.toDate === "function") {
    date = value.toDate();
  } else if (value._seconds) {
    date = new Date(value._seconds * 1000);
  } else {
    date = new Date(value);
  }

  if (Number.isNaN(date.getTime())) {
    return "-";
  }

  return date.toLocaleString("en-MY", {
    dateStyle: "medium",
    timeStyle: "short",
  });
}

// Get timestamp for sorting
function getFeedbackTime(feedback) {
  const value =
    feedback.timestamp ||
    feedback.created_time ||
    feedback.created_at;

  if (!value) {
    return 0;
  }

  if (typeof value.toMillis === "function") {
    return value.toMillis();
  }

  if (value._seconds) {
    return value._seconds * 1000;
  }

  const parsedDate = new Date(value).getTime();

  return Number.isNaN(parsedDate)
    ? 0
    : parsedDate;
}

// Root
app.get("/", (req, res) => {
  if (req.session.user) {
    return res.redirect("/dashboard");
  }

  return res.redirect("/login");
});

// Login
app.get("/login", (req, res) => {
  if (req.session.user) {
    return res.redirect("/dashboard");
  }

  return res.render("login", {
    errorMessage: "",
  });
});

// Firebase login session
app.post("/auth/session", async (req, res) => {
  try {
    const idToken = req.body.idToken;

    if (!idToken) {
      return res.status(400).json({
        message:
          "Authentication token is required.",
      });
    }

    const decodedToken =
      await auth.verifyIdToken(idToken);

    const uid = decodedToken.uid;

    const userDocument = await db
      .collection("users")
      .doc(uid)
      .get();

    if (!userDocument.exists) {
      return res.status(401).json({
        message:
          "User record was not found in Firestore.",
      });
    }

    const userData = userDocument.data();

    const userRole = String(
      userData.role || ""
    ).trim();

    if (userRole.toLowerCase() !== "hr") {
      return res.status(403).json({
        message:
          "Access denied. This account is not an HR account.",
      });
    }

    req.session.user = {
      uid,
      email: decodedToken.email || "",
      role: userRole,

      displayName:
        userData.display_name ||
        userData.displayName ||
        "HR Administrator",
    };

    return res.json({
      success: true,
      message: "Login successful.",
    });
  } catch (error) {
    console.error(
      "Authentication error:",
      error
    );

    return res.status(401).json({
      message:
        "Login failed. Please check your email and password.",
    });
  }
});

// Dashboard
app.get(
  "/dashboard",
  requireHR,
  async (req, res) => {
    try {
      const snapshot = await db
        .collection("feedback")
        .get();

      const feedbackList =
        snapshot.docs.map((document) => ({
          id: document.id,
          ...document.data(),
        }));

      const totalFeedback =
        feedbackList.length;

      const pendingFeedback =
        feedbackList.filter(
          (feedback) =>
            normalizeStatus(
              feedback.status
            ) === "pending"
        ).length;

      const inProgressFeedback =
        feedbackList.filter(
          (feedback) =>
            normalizeStatus(
              feedback.status
            ) === "in progress"
        ).length;

      const resolvedFeedback =
        feedbackList.filter(
          (feedback) =>
            normalizeStatus(
              feedback.status
            ) === "resolved"
        ).length;

      const categoryCount = {};

      feedbackList.forEach((feedback) => {
        const category =
          getCategory(feedback);

        categoryCount[category] =
          (categoryCount[category] || 0) + 1;
      });

      const categoryLabels =
        Object.keys(categoryCount);

      const categoryValues =
        Object.values(categoryCount);

      feedbackList.sort(
        (firstFeedback, secondFeedback) =>
          getFeedbackTime(secondFeedback) -
          getFeedbackTime(firstFeedback)
      );

      return res.render("dashboard", {
        feedbackList,
        totalFeedback,
        pendingFeedback,
        inProgressFeedback,
        resolvedFeedback,
        categoryLabels,
        categoryValues,
        currentUser: req.session.user,
      });
    } catch (error) {
      console.error(
        "Dashboard error:",
        error
      );

      return res.status(500).send(
        "Unable to load HR dashboard."
      );
    }
  }
);

// Manage Feedback
app.get(
  "/feedback",
  requireHR,
  async (req, res) => {
    try {
      const snapshot = await db
        .collection("feedback")
        .get();

      let feedbackList =
        snapshot.docs.map((document) => ({
          id: document.id,
          ...document.data(),
        }));

      const search = String(
        req.query.search || ""
      )
        .trim()
        .toLowerCase();

      const statusFilter = String(
        req.query.status || "All"
      ).trim();

      if (search) {
        feedbackList =
          feedbackList.filter(
            (feedback) => {
              const category =
                getCategory(feedback)
                  .toLowerCase();

              const department =
                getDepartment(feedback)
                  .toLowerCase();

              const details =
                String(
                  getFeedbackDetails(feedback)
                ).toLowerCase();

              const submittedBy =
                String(
                  getSubmittedBy(feedback)
                ).toLowerCase();

              return (
                category.includes(search) ||
                department.includes(search) ||
                details.includes(search) ||
                submittedBy.includes(search)
              );
            }
          );
      }

      if (
        statusFilter &&
        statusFilter.toLowerCase() !== "all"
      ) {
        feedbackList =
          feedbackList.filter(
            (feedback) =>
              normalizeStatus(
                feedback.status
              ) ===
              statusFilter.toLowerCase()
          );
      }

      feedbackList.sort(
        (firstFeedback, secondFeedback) =>
          getFeedbackTime(secondFeedback) -
          getFeedbackTime(firstFeedback)
      );

      return res.render("feedback", {
        feedbackList,

        successMessage:
          req.query.success || "",

        errorMessage:
          req.query.error || "",

        currentUser:
          req.session.user,

        searchValue:
          req.query.search || "",

        selectedStatus:
          statusFilter,
      });
    } catch (error) {
      console.error(
        "Manage feedback error:",
        error
      );

      return res.status(500).send(
        "Unable to load Manage Feedback page."
      );
    }
  }
);

// Update feedback
app.post(
  "/feedback/:id/update",
  requireHR,
  async (req, res) => {
    try {
      const feedbackId =
        req.params.id;

      const status = String(
        req.body.status || ""
      ).trim();

      const hrResponse = String(
        req.body.hr_response || ""
      ).trim();

      const allowedStatuses = [
        "Pending",
        "In Progress",
        "Resolved",
      ];

      if (
        !allowedStatuses.includes(status)
      ) {
        return res.redirect(
          "/feedback?error=" +
            encodeURIComponent(
              "Invalid feedback status."
            )
        );
      }

      const feedbackReference = db
        .collection("feedback")
        .doc(feedbackId);

      const feedbackDocument =
        await feedbackReference.get();

      if (!feedbackDocument.exists) {
        return res.redirect(
          "/feedback?error=" +
            encodeURIComponent(
              "Feedback was not found."
            )
        );
      }

      const feedbackData =
        feedbackDocument.data();

      await feedbackReference.update({
        status,
        hr_response: hrResponse,
        updated_at: new Date(),
      });

      const category =
        getCategory(feedbackData);

      await db
        .collection("notifications")
        .add({
          title:
            "Feedback Status Updated",

          message:
            `Your ${category} feedback ` +
            `has been updated to ${status}.`,

          status,
          is_read: false,
          created_time: new Date(),
          feedback_id: feedbackId,

          user_refdocument:
            feedbackData.user_refdocument ||
            null,
        });

      return res.redirect(
        "/feedback?success=" +
          encodeURIComponent(
            "Feedback updated and notification created successfully."
          )
      );
    } catch (error) {
      console.error(
        "Update feedback error:",
        error
      );

      return res.redirect(
        "/feedback?error=" +
          encodeURIComponent(
            "Unable to update feedback."
          )
      );
    }
  }
);

// Report
app.get(
  "/report",
  requireHR,
  async (req, res) => {
    try {
      const snapshot = await db
        .collection("feedback")
        .get();

      const feedbackList =
        snapshot.docs.map((document) => ({
          id: document.id,
          ...document.data(),
        }));

      feedbackList.sort(
        (firstFeedback, secondFeedback) =>
          getFeedbackTime(secondFeedback) -
          getFeedbackTime(firstFeedback)
      );

      const pendingList =
        feedbackList.filter(
          (feedback) =>
            normalizeStatus(
              feedback.status
            ) === "pending"
        );

      const inProgressList =
        feedbackList.filter(
          (feedback) =>
            normalizeStatus(
              feedback.status
            ) === "in progress"
        );

      const resolvedList =
        feedbackList.filter(
          (feedback) =>
            normalizeStatus(
              feedback.status
            ) === "resolved"
        );

      return res.render("report", {
        pendingList,
        inProgressList,
        resolvedList,
        currentUser:
          req.session.user,
      });
    } catch (error) {
      console.error(
        "Report error:",
        error
      );

      return res.status(500).send(
        "Unable to load report page."
      );
    }
  }
);

// Download complete report PDF
// This route must remain before /report/:id
app.get(
  "/report/pdf",
  requireHR,
  async (req, res) => {
    try {
      const snapshot = await db
        .collection("feedback")
        .get();

      const feedbackList =
        snapshot.docs.map((document) => ({
          id: document.id,
          ...document.data(),
        }));

      feedbackList.sort(
        (firstFeedback, secondFeedback) =>
          getFeedbackTime(secondFeedback) -
          getFeedbackTime(firstFeedback)
      );

      const pendingList =
        feedbackList.filter(
          (feedback) =>
            normalizeStatus(
              feedback.status
            ) === "pending"
        );

      const inProgressList =
        feedbackList.filter(
          (feedback) =>
            normalizeStatus(
              feedback.status
            ) === "in progress"
        );

      const resolvedList =
        feedbackList.filter(
          (feedback) =>
            normalizeStatus(
              feedback.status
            ) === "resolved"
        );

      const pdf = new PDFDocument({
        size: "A4",
        margin: 45,
        bufferPages: true,
      });

      const filename =
        `hr-feedback-report-${Date.now()}.pdf`;

      res.setHeader(
        "Content-Type",
        "application/pdf"
      );

      res.setHeader(
        "Content-Disposition",
        `attachment; filename="${filename}"`
      );

      pdf.pipe(res);

      const logoPath = path.join(
        __dirname,
        "public",
        "images",
        "metropolitan-logo.jpg"
      );

      try {
        pdf.image(logoPath, {
          fit: [220, 70],
          align: "center",
        });
      } catch (logoError) {
        console.warn(
          "Unable to add logo to PDF:",
          logoError.message
        );
      }

      pdf
        .moveDown(0.7)
        .font("Helvetica-Bold")
        .fontSize(20)
        .fillColor("#0D2C8C")
        .text(
          "HR Feedback Portal",
          {
            align: "center",
          }
        );

      pdf
        .font("Helvetica")
        .fontSize(11)
        .fillColor("#444444")
        .text(
          "HR Feedback Management System",
          {
            align: "center",
          }
        );

      pdf
        .moveDown(0.4)
        .fontSize(9)
        .text(
          `Generated: ${new Date().toLocaleString(
            "en-MY",
            {
              dateStyle: "medium",
              timeStyle: "short",
            }
          )}`,
          {
            align: "center",
          }
        );

      pdf
        .moveDown(1)
        .font("Helvetica-Bold")
        .fontSize(14)
        .fillColor("#000000")
        .text("Report Summary");

      pdf
        .moveDown(0.6)
        .font("Helvetica")
        .fontSize(10)
        .text(
          `Total Feedback: ${feedbackList.length}`
        )
        .text(
          `Pending: ${pendingList.length}`
        )
        .text(
          `Current / In Progress: ${inProgressList.length}`
        )
        .text(
          `Completed / Resolved: ${resolvedList.length}`
        );

      const addFeedbackSection = (
        sectionTitle,
        records
      ) => {
        pdf
          .moveDown(1.2)
          .font("Helvetica-Bold")
          .fontSize(14)
          .fillColor("#0D2C8C")
          .text(sectionTitle);

        pdf.fillColor("#000000");

        if (records.length === 0) {
          pdf
            .moveDown(0.5)
            .font("Helvetica-Oblique")
            .fontSize(10)
            .text(
              "No feedback records available."
            );

          return;
        }

        records.forEach(
          (feedback, index) => {
            if (pdf.y > 650) {
              pdf.addPage();
            }

            pdf
              .moveDown(0.8)
              .font("Helvetica-Bold")
              .fontSize(11)
              .text(
                `${index + 1}. ${getCategory(
                  feedback
                )}`
              );

            pdf
              .font("Helvetica")
              .fontSize(9.5)
              .text(
                `Responsible Department: ${getDepartment(
                  feedback
                )}`
              )
              .text(
                `Status: ${
                  feedback.status || "Pending"
                }`
              )
              .text(
                `Submitted By: ${getSubmittedBy(
                  feedback
                )}`
              )
              .text(
                `Submitted Date: ${formatDate(
                  feedback.timestamp ||
                  feedback.created_time ||
                  feedback.created_at
                )}`
              );

            pdf
              .moveDown(0.3)
              .font("Helvetica-Bold")
              .text("Feedback Details:");

            pdf
              .font("Helvetica")
              .text(
                getFeedbackDetails(
                  feedback
                )
              );

            pdf
              .moveDown(0.3)
              .font("Helvetica-Bold")
              .text("HR Response:");

            pdf
              .font("Helvetica")
              .text(
                feedback.hr_response ||
                "No response yet."
              );

            pdf
              .moveDown(0.7)
              .strokeColor("#dddddd")
              .moveTo(45, pdf.y)
              .lineTo(550, pdf.y)
              .stroke();
          }
        );
      };

      addFeedbackSection(
        "Pending Feedback",
        pendingList
      );

      addFeedbackSection(
        "Current Feedback",
        inProgressList
      );

      addFeedbackSection(
        "Completed Feedback",
        resolvedList
      );

      const pageRange =
        pdf.bufferedPageRange();

      for (
        let pageIndex = 0;
        pageIndex < pageRange.count;
        pageIndex += 1
      ) {
        pdf.switchToPage(pageIndex);

        pdf
          .font("Helvetica")
          .fontSize(8)
          .fillColor("#777777")
          .text(
            `HR Feedback Portal | Page ${
              pageIndex + 1
            } of ${pageRange.count}`,
            45,
            800,
            {
              align: "center",
              width: 505,
            }
          );
      }

      pdf.end();
    } catch (error) {
      console.error(
        "PDF generation error:",
        error
      );

      if (!res.headersSent) {
        return res.status(500).send(
          "Unable to generate feedback report PDF."
        );
      }
    }
  }
);

// Individual feedback details
app.get(
  "/report/:id",
  requireHR,
  async (req, res) => {
    try {
      const feedbackDocument =
        await db
          .collection("feedback")
          .doc(req.params.id)
          .get();

      if (!feedbackDocument.exists) {
        return res
          .status(404)
          .send(
            "Feedback record not found."
          );
      }

      const feedback = {
        id: feedbackDocument.id,
        ...feedbackDocument.data(),
      };

      return res.render(
        "report-detail",
        {
          feedback,
          currentUser:
            req.session.user,
        }
      );
    } catch (error) {
      console.error(
        "Feedback detail error:",
        error
      );

      return res.status(500).send(
        "Unable to load feedback details."
      );
    }
  }
);

// Logout
app.get("/logout", (req, res) => {
  req.session.destroy((error) => {
    if (error) {
      console.error(
        "Logout error:",
        error
      );

      return res.status(500).send(
        "Unable to log out."
      );
    }

    res.clearCookie("connect.sid");

    return res.redirect("/login");
  });
});

// Page not found
app.use((req, res) => {
  return res
    .status(404)
    .send("Page not found.");
});

// Start server
app.listen(PORT, () => {
  console.log(
    `Server running at http://localhost:${PORT}`
  );
});