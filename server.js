require("dotenv").config();

const express = require("express");
const path = require("path");
const session = require("express-session");
const { db, auth } = require("./config/firebase");

const app = express();
const PORT = process.env.PORT || 3000;

// Setup EJS
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

// Middleware untuk protect HR pages
function requireHR(req, res, next) {
  if (!req.session.user) {
    return res.redirect("/login");
  }

  if (
    String(req.session.user.role || "").toLowerCase() !== "hr"
  ) {
    return res.status(403).send("Access denied.");
  }

  next();
}

// Root page
app.get("/", (req, res) => {
  if (req.session.user) {
    return res.redirect("/dashboard");
  }

  res.redirect("/login");
});

// Login page
app.get("/login", (req, res) => {
  if (req.session.user) {
    return res.redirect("/dashboard");
  }

  res.render("login", {
    errorMessage: "",
  });
});

// Verify Firebase login token dan create session
app.post("/auth/session", async (req, res) => {
  try {
    const idToken = req.body.idToken;

    if (!idToken) {
      return res.status(400).json({
        message: "Authentication token is required.",
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

    res.json({
      success: true,
      message: "Login successful.",
    });
  } catch (error) {
    console.error(
      "Authentication error:",
      error
    );

    res.status(401).json({
      message:
        "Login failed. Please check your email and password.",
    });
  }
});

// HR Dashboard
app.get(
  "/dashboard",
  requireHR,
  async (req, res) => {
    try {
      const snapshot = await db
        .collection("feedback")
        .get();

      const feedbackList =
        snapshot.docs.map((doc) => ({
          id: doc.id,
          ...doc.data(),
        }));

      const totalFeedback =
        feedbackList.length;

      const pendingFeedback =
        feedbackList.filter(
          (feedback) =>
            String(feedback.status || "")
              .trim()
              .toLowerCase() === "pending"
        ).length;

      const inProgressFeedback =
        feedbackList.filter(
          (feedback) =>
            String(feedback.status || "")
              .trim()
              .toLowerCase() ===
            "in progress"
        ).length;

      const resolvedFeedback =
        feedbackList.filter(
          (feedback) =>
            String(feedback.status || "")
              .trim()
              .toLowerCase() === "resolved"
        ).length;

      res.render("dashboard", {
        feedbackList,
        totalFeedback,
        pendingFeedback,
        inProgressFeedback,
        resolvedFeedback,
        currentUser: req.session.user,
      });
    } catch (error) {
      console.error(
        "Dashboard error:",
        error
      );

      res.status(500).send(
        "Unable to load HR dashboard."
      );
    }
  }
);

// Manage Feedback page
app.get(
  "/feedback",
  requireHR,
  async (req, res) => {
    try {
      const snapshot = await db
        .collection("feedback")
        .get();

      let feedbackList =
        snapshot.docs.map((doc) => ({
          id: doc.id,
          ...doc.data(),
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
        feedbackList = feedbackList.filter(
          (feedback) => {
            const title = String(
              feedback.title || ""
            ).toLowerCase();

            const category = String(
              feedback.category || ""
            ).toLowerCase();

            const submittedBy = String(
              feedback.submitted_by || ""
            ).toLowerCase();

            const message = String(
              feedback.message || ""
            ).toLowerCase();

            return (
              title.includes(search) ||
              category.includes(search) ||
              submittedBy.includes(search) ||
              message.includes(search)
            );
          }
        );
      }

      if (
        statusFilter &&
        statusFilter.toLowerCase() !== "all"
      ) {
        feedbackList = feedbackList.filter(
          (feedback) =>
            String(feedback.status || "")
              .trim()
              .toLowerCase() ===
            statusFilter.toLowerCase()
        );
      }

      res.render("feedback", {
        feedbackList,
        successMessage:
          req.query.success || "",
        errorMessage:
          req.query.error || "",
        currentUser: req.session.user,
        searchValue: req.query.search || "",
        selectedStatus: statusFilter,
      });
    } catch (error) {
      console.error(
        "Manage feedback error:",
        error
      );

      res.status(500).send(
        "Unable to load Manage Feedback page."
      );
    }
  }
);

// Update feedback status dan HR response
app.post(
  "/feedback/:id/update",
  requireHR,
  async (req, res) => {
    try {
      const feedbackId = req.params.id;

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

      if (!allowedStatuses.includes(status)) {
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

      await db
        .collection("notifications")
        .add({
          title: "Feedback Status Updated",
          message:
            `Your feedback "${feedbackData.title || "Feedback"}" ` +
            `has been updated to ${status}.`,
          status,
          is_read: false,
          created_time: new Date(),
          feedback_id: feedbackId,
          user_refdocument:
            feedbackData.user_refdocument || null,
        });

      res.redirect(
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

      res.redirect(
        "/feedback?error=" +
          encodeURIComponent(
            "Unable to update feedback."
          )
      );
    }
  }
);

// Report page
app.get(
  "/report",
  requireHR,
  async (req, res) => {
    try {
      const snapshot = await db
        .collection("feedback")
        .get();

      const feedbackList =
        snapshot.docs.map((doc) => ({
          id: doc.id,
          ...doc.data(),
        }));

      const totalFeedback =
        feedbackList.length;

      const pendingFeedback =
        feedbackList.filter(
          (feedback) =>
            String(feedback.status || "")
              .trim()
              .toLowerCase() === "pending"
        ).length;

      const inProgressFeedback =
        feedbackList.filter(
          (feedback) =>
            String(feedback.status || "")
              .trim()
              .toLowerCase() ===
            "in progress"
        ).length;

      const resolvedFeedback =
        feedbackList.filter(
          (feedback) =>
            String(feedback.status || "")
              .trim()
              .toLowerCase() === "resolved"
        ).length;

      const calculatePercentage = (
        value
      ) => {
        if (totalFeedback === 0) {
          return 0;
        }

        return Math.round(
          (value / totalFeedback) * 100
        );
      };

      const pendingPercentage =
        calculatePercentage(
          pendingFeedback
        );

      const inProgressPercentage =
        calculatePercentage(
          inProgressFeedback
        );

      const resolvedPercentage =
        calculatePercentage(
          resolvedFeedback
        );

      const categoryCount = {};

      feedbackList.forEach(
        (feedback) => {
          const category = String(
            feedback.category ||
              "Uncategorized"
          ).trim();

          categoryCount[category] =
            (categoryCount[category] ||
              0) + 1;
        }
      );

      const categoryLabels =
        Object.keys(categoryCount);

      const categoryValues =
        Object.values(categoryCount);

      res.render("report", {
        totalFeedback,
        pendingFeedback,
        inProgressFeedback,
        resolvedFeedback,
        pendingPercentage,
        inProgressPercentage,
        resolvedPercentage,
        categoryLabels,
        categoryValues,
        currentUser: req.session.user,
      });
    } catch (error) {
      console.error(
        "Report error:",
        error
      );

      res.status(500).send(
        "Unable to load report page."
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
    res.redirect("/login");
  });
});

// Handle page not found
app.use((req, res) => {
  res.status(404).send(
    "Page not found."
  );
});

// Start server
app.listen(PORT, () => {
  console.log(
    `Server running at http://localhost:${PORT}`
  );
});