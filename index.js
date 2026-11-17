import express from "express";
import cors from "cors";
import "dotenv/config";
import { MongoClient, ObjectId } from "mongodb";
import Stripe from "stripe";

const app = express();
const port = process.env.PORT || 5000;
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

// CORS সেটআপ (Frontend থেকে কল করার জন্য)
app.use(cors({ origin: process.env.CLIENT_URL, credentials: true }));

// ==========================================
// 🔗 MONGODB CONNECTION
// ==========================================
const mongoUri =
  process.env.MONGODB_URI || process.env.MONGO_URI ||
  `mongodb+srv://${process.env.DB_USER}:${process.env.DB_PASSWORD}@cluster0.rffvcgh.mongodb.net/?retryWrites=true&w=majority`;

const client = new MongoClient(mongoUri);
let db;
let collections;

async function connectDB() {
  try {
    await client.connect();
    console.log("✅ Connected to MongoDB");
    db = client.db(process.env.DB_NAME || "vowvista");
    
    collections = {
      users: db.collection("user"),          // Better Auth-managed
      sessions: db.collection("session"),    // Better Auth-managed
      services: db.collection("services"),
      bookings: db.collection("bookings"),
      transactions: db.collection("transactions"),
    };
  } catch (error) {
    console.error(`❌ MongoDB connection failed: ${error.message}`);
    process.exit(1);
  }
}

// ==========================================
// 🔐 AUTH & ROLE MIDDLEWARES
// ==========================================
const verifyToken = async (req, res, next) => {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return res.status(401).send({ message: "Unauthorized: No token provided" });
  }

  const token = authHeader.split(" ")[1];
  try {
    const session = await collections.sessions.findOne({ token });
    if (!session) {
      return res.status(401).send({ message: "Unauthorized: Invalid or expired token" });
    }

    const user = await collections.users.findOne({ _id: new ObjectId(session.userId) });
    if (!user) {
      return res.status(401).send({ message: "Unauthorized: User not found" });
    }
    if (user.isBlocked) {
      return res.status(403).send({ message: "Forbidden: Your account has been blocked" });
    }

    req.user = user;
    next();
  } catch (error) {
    return res.status(500).send({ message: "Internal Server Error" });
  }
};

const verifyRole = (roles) => {
  return (req, res, next) => {
    if (!req.user || !roles.includes(req.user.role)) {
      return res.status(403).send({ message: "Forbidden: You do not have permission to access this resource" });
    }
    next();
  };
};

// ==========================================
// 💍 SERVICES ROUTES
// ==========================================

// ১. Public: Approved + Active Services (Search, Filter, Sort)
app.get("/services", async (req, res) => {
  try {
    const { search, category, location, sort } = req.query;
    let query = { status: "approved", isActive: true };

    if (search) query.serviceName = { $regex: search, $options: "i" };
    if (category) query.category = category;
    if (location) query.location = { $regex: location, $options: "i" };

    let sortOption = {};
    if (sort === "asc") sortOption.price = 1;
    if (sort === "desc") sortOption.price = -1;

    const services = await collections.services.find(query).sort(sortOption).toArray();
    res.send(services);
  } catch (error) {
    res.status(500).send({ message: "Failed to fetch services" });
  }
});

// ২. Vendor: নিজের সব সার্ভিস দেখা
app.get("/services/vendor", verifyToken, verifyRole(["vendor"]), async (req, res) => {
  try {
    const services = await collections.services.find({ vendorId: req.user._id.toString() }).toArray();
    res.send(services);
  } catch (error) {
    res.status(500).send({ message: "Failed to fetch vendor services" });
  }
});

// ৩. Public: নির্দিষ্ট সার্ভিসের ডিটেইলস
app.get("/services/:id", async (req, res) => {
  try {
    const id = req.params.id;
    if (!ObjectId.isValid(id)) return res.status(400).send({ message: "Invalid Service ID format" });

    const service = await collections.services.findOne({ _id: new ObjectId(id) });
    if (!service) return res.status(404).send({ message: "Service not found" });
    
    res.send(service);
  } catch (error) {
    res.status(500).send({ message: "Failed to fetch service details" });
  }
});

// ৪. Vendor: নতুন সার্ভিস তৈরি
app.post("/services", verifyToken, verifyRole(["vendor"]), async (req, res) => {
  try {
    const { serviceName, category, description, price, location, images } = req.body;

    // ফ্রি প্ল্যান লিমিট চেক (সর্বোচ্চ ৩টি)
    if (req.user.subscriptionPlan !== "premium") {
      const activeCount = await collections.services.countDocuments({
        vendorId: req.user._id.toString(),
        isActive: true,
      });
      if (activeCount >= 3) {
        return res.status(403).send({ message: "Free plan limit reached. Upgrade to Premium." });
      }
    }

    const newService = {
      vendorId: req.user._id.toString(),
      serviceName,
      category,
      description,
      price: Number(price),
      location,
      images: images || [],
      status: "pending",
      isActive: true,
      createdAt: new Date(),
    };

    const result = await collections.services.insertOne(newService);
    res.status(201).send(result);
  } catch (error) {
    res.status(500).send({ message: "Failed to create service" });
  }
});

// ৫. Vendor: সার্ভিস আপডেট
app.patch("/services/:id", verifyToken, verifyRole(["vendor"]), async (req, res) => {
  try {
    const id = req.params.id;
    if (!ObjectId.isValid(id)) return res.status(400).send({ message: "Invalid Service ID" });

    const service = await collections.services.findOne({ _id: new ObjectId(id) });
    if (!service) return res.status(404).send({ message: "Service not found" });
    if (service.vendorId !== req.user._id.toString()) {
      return res.status(403).send({ message: "Forbidden: You can only update your own services" });
    }

    const updatedDoc = {
      $set: {
        serviceName: req.body.serviceName || service.serviceName,
        category: req.body.category || service.category,
        description: req.body.description || service.description,
        price: req.body.price ? Number(req.body.price) : service.price,
        location: req.body.location || service.location,
        images: req.body.images || service.images,
        isActive: req.body.isActive !== undefined ? req.body.isActive : service.isActive,
      }
    };

    const result = await collections.services.updateOne({ _id: new ObjectId(id) }, updatedDoc);
    res.send(result);
  } catch (error) {
    res.status(500).send({ message: "Failed to update service" });
  }
});

// ৬. Vendor: সার্ভিস ডিলিট
app.delete("/services/:id", verifyToken, verifyRole(["vendor"]), async (req, res) => {
  try {
    const id = req.params.id;
    if (!ObjectId.isValid(id)) return res.status(400).send({ message: "Invalid Service ID" });

    const service = await collections.services.findOne({ _id: new ObjectId(id) });
    if (!service) return res.status(404).send({ message: "Service not found" });
    if (service.vendorId !== req.user._id.toString()) {
      return res.status(403).send({ message: "Forbidden: You can only delete your own services" });
    }

    const result = await collections.services.deleteOne({ _id: new ObjectId(id) });
    res.send(result);
  } catch (error) {
    res.status(500).send({ message: "Failed to delete service" });
  }
});

// ৭. Admin: সার্ভিস Approve / Reject
app.patch("/services/:id/status", verifyToken, verifyRole(["admin"]), async (req, res) => {
  try {
    const { status } = req.body;
    if (!["approved", "rejected"].includes(status)) {
      return res.status(400).send({ message: "Invalid status value" });
    }

    const result = await collections.services.updateOne(
      { _id: new ObjectId(req.params.id) },
      { $set: { status } }
    );
    res.send(result);
  } catch (error) {
    res.status(500).send({ message: "Failed to update service status" });
  }
});

// ==========================================
// 📅 BOOKINGS ROUTES
// ==========================================

// ১. Customer: নতুন বুকিং তৈরি
app.post("/bookings", verifyToken, verifyRole(["customer"]), async (req, res) => {
  try {
    const { serviceId, eventDate, eventLocation, message } = req.body;
    if (!ObjectId.isValid(serviceId)) return res.status(400).send({ message: "Invalid Service ID" });

    const service = await collections.services.findOne({ _id: new ObjectId(serviceId), status: "approved", isActive: true });
    if (!service) return res.status(404).send({ message: "Service not available for booking" });

    // নিজের সার্ভিস বুক করা যাবে না
    if (service.vendorId === req.user._id.toString()) {
      return res.status(403).send({ message: "You cannot book your own service" });
    }

    // ডুপ্লিকেট বুকিং চেক (একই সার্ভিস, একই তারিখে pending/accepted থাকলে)
    const existingBooking = await collections.bookings.findOne({
      serviceId: serviceId,
      customerId: req.user._id.toString(),
      eventDate: eventDate,
      status: { $in: ["pending", "accepted"] }
    });
    if (existingBooking) {
      return res.status(400).send({ message: "You already have an active booking for this date." });
    }

    const newBooking = {
      serviceId,
      vendorId: service.vendorId,
      customerId: req.user._id.toString(),
      eventDate,
      eventLocation,
      message,
      status: "pending",
      createdAt: new Date(),
    };

    const result = await collections.bookings.insertOne(newBooking);
    res.status(201).send(result);
  } catch (error) {
    res.status(500).send({ message: "Failed to create booking" });
  }
});

// ২. Customer: নিজের বুকিং লিস্ট
app.get("/bookings/customer", verifyToken, verifyRole(["customer"]), async (req, res) => {
  try {
    const bookings = await collections.bookings.find({ customerId: req.user._id.toString() }).sort({ createdAt: -1 }).toArray();
    res.send(bookings);
  } catch (error) {
    res.status(500).send({ message: "Failed to fetch bookings" });
  }
});

// ৩. Vendor: নিজের সার্ভিসের বুকিং লিস্ট
app.get("/bookings/vendor", verifyToken, verifyRole(["vendor"]), async (req, res) => {
  try {
    const bookings = await collections.bookings.find({ vendorId: req.user._id.toString() }).sort({ createdAt: -1 }).toArray();
    res.send(bookings);
  } catch (error) {
    res.status(500).send({ message: "Failed to fetch vendor bookings" });
  }
});

// ৪. Vendor: বুকিং Accept/Reject
app.patch("/bookings/:id/status", verifyToken, verifyRole(["vendor"]), async (req, res) => {
  try {
    const { status } = req.body;
    if (!["accepted", "rejected"].includes(status)) return res.status(400).send({ message: "Invalid status" });

    const booking = await collections.bookings.findOne({ _id: new ObjectId(req.params.id) });
    if (!booking) return res.status(404).send({ message: "Booking not found" });
    if (booking.vendorId !== req.user._id.toString()) return res.status(403).send({ message: "Forbidden" });
    if (booking.status !== "pending") return res.status(400).send({ message: "Only pending requests can be processed" });

    const result = await collections.bookings.updateOne({ _id: new ObjectId(req.params.id) }, { $set: { status } });
    res.send(result);
  } catch (error) {
    res.status(500).send({ message: "Failed to update booking" });
  }
});

// ৫. Customer: বুকিং Cancel
app.patch("/bookings/:id/cancel", verifyToken, verifyRole(["customer"]), async (req, res) => {
  try {
    const booking = await collections.bookings.findOne({ _id: new ObjectId(req.params.id) });
    if (!booking) return res.status(404).send({ message: "Booking not found" });
    if (booking.customerId !== req.user._id.toString()) return res.status(403).send({ message: "Forbidden" });
    if (booking.status !== "pending") return res.status(400).send({ message: "Only pending bookings can be cancelled" });

    const result = await collections.bookings.updateOne({ _id: new ObjectId(req.params.id) }, { $set: { status: "cancelled" } });
    res.send(result);
  } catch (error) {
    res.status(500).send({ message: "Failed to cancel booking" });
  }
});

// ==========================================
// 👑 ADMIN ROUTES
// ==========================================

// ১. Admin: ড্যাশবোর্ড স্ট্যাটস
app.get("/admin/stats", verifyToken, verifyRole(["admin"]), async (req, res) => {
  try {
    const totalUsers = await collections.users.countDocuments();
    const totalVendors = await collections.users.countDocuments({ role: "vendor" });
    const totalCustomers = await collections.users.countDocuments({ role: "customer" });
    const totalServices = await collections.services.countDocuments();
    const pendingServices = await collections.services.countDocuments({ status: "pending" });
    const totalTransactions = await collections.transactions.countDocuments({ status: "success" });

    res.send({ totalUsers, totalVendors, totalCustomers, totalServices, pendingServices, totalTransactions });
  } catch (error) {
    res.status(500).send({ message: "Failed to fetch stats" });
  }
});

// ২. Admin: সব ইউজার লিস্ট, সার্চ ও ফিল্টার
app.get("/admin/users", verifyToken, verifyRole(["admin"]), async (req, res) => {
  try {
    const { search, role } = req.query;
    let query = {};
    if (search) {
      query.$or = [
        { name: { $regex: search, $options: "i" } },
        { email: { $regex: search, $options: "i" } }
      ];
    }
    if (role) query.role = role;

    const users = await collections.users.find(query).sort({ createdAt: -1 }).toArray();
    res.send(users);
  } catch (error) {
    res.status(500).send({ message: "Failed to fetch users" });
  }
});

// ৩. Admin: ইউজার Block / Unblock
app.patch("/admin/users/:id/block", verifyToken, verifyRole(["admin"]), async (req, res) => {
  try {
    const user = await collections.users.findOne({ _id: new ObjectId(req.params.id) });
    if (!user) return res.status(404).send({ message: "User not found" });

    const result = await collections.users.updateOne(
      { _id: new ObjectId(req.params.id) },
      { $set: { isBlocked: !user.isBlocked } }
    );
    res.send(result);
  } catch (error) {
    res.status(500).send({ message: "Failed to update user" });
  }
});

// ৪. Admin: সব সার্ভিস লিস্ট (Approve/Reject এর জন্য)
app.get("/admin/services", verifyToken, verifyRole(["admin"]), async (req, res) => {
  try {
    const services = await collections.services.find().sort({ createdAt: -1 }).toArray();
    res.send(services);
  } catch (error) {
    res.status(500).send({ message: "Failed to fetch services" });
  }
});

// ৫. Admin: সব ট্রানজেকশন লিস্ট
app.get("/admin/transactions", verifyToken, verifyRole(["admin"]), async (req, res) => {
  try {
    const transactions = await collections.transactions.find().sort({ createdAt: -1 }).toArray();
    res.send(transactions);
  } catch (error) {
    res.status(500).send({ message: "Failed to fetch transactions" });
  }
});


// ==========================================
// 💳 STRIPE ROUTES
// ==========================================

// ১. Stripe Checkout Session তৈরি (Vendor Premium Upgrade এর জন্য)
app.post("/payments/create-checkout-session", verifyToken, verifyRole(["vendor"]), async (req, res) => {
  try {
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ["card"],
      mode: "subscription", // সাবস্ক্রিপশন মোড (রিকোয়ারমেন্ট অনুযায়ী)
      line_items: [
        {
          price_data: {
            currency: "usd",
            product_data: { name: "VowVista Premium Subscription" },
            unit_amount: 500, // $5.00 ডলার
            recurring: { interval: "month" } // প্রতি মাসে
          },
          quantity: 1,
        },
      ],
      metadata: {
        vendorId: req.user._id.toString(),
      },
      success_url: `${process.env.CLIENT_URL}/payment/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${process.env.CLIENT_URL}/payment/cancel`,
    });

    res.send({ url: session.url });
  } catch (error) {
    res.status(500).send({ message: "Failed to create checkout session" });
  }
});

// ২. Stripe Webhook (Premium Activate করার জন্য - raw body দরকার)
app.post("/payments/webhook", express.raw({ type: 'application/json' }), async (req, res) => {
  const sig = req.headers['stripe-signature'];
  let event;

  try {
    event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error("Webhook Error:", err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  // পেমেন্ট সফল হলে ট্রানজেকশন সেভ এবং ইউজারকে প্রিমিয়াম বানানো
  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;

    // পেমেন্ট ডুপ্লিকেট কিনা চেক (সেশন আইডি দিয়ে)
    const existingTx = await collections.transactions.findOne({ stripeSessionId: session.id });
    if (!existingTx) {
      const vendorId = session.metadata.vendorId;

      // ১. ট্রানজেকশন সেভ
      const transaction = {
        vendorId: vendorId,
        plan: "premium",
        amount: session.amount_total / 100, // সেন্ট থেকে ডলারে কনভার্ট
        currency: session.currency,
        stripeSessionId: session.id,
        stripeSubscriptionId: session.subscription,
        status: "success",
        createdAt: new Date(),
      };
      await collections.transactions.insertOne(transaction);

      // ২. ইউজারকে প্রিমিয়াম বানানো (৩০ দিনের জন্য)
      const expiryDate = new Date();
      expiryDate.setDate(expiryDate.getDate() + 30);

      await collections.users.updateOne(
        { _id: new ObjectId(vendorId) },
        {
          $set: {
            subscriptionPlan: "premium",
            subscriptionExpiresAt: expiryDate
          }
        }
      );
      console.log(`✅ Premium activated for vendor: ${vendorId}`);
    }
  }

  res.send({ received: true });
});


// ==========================================
// 🚀 SERVER START
// ==========================================
async function startServer() {
  await connectDB();
  app.use(express.json()); // সাধারণ রিকোয়েস্টের জন্য (Webhook এর বাইরে)
  
  app.listen(port, () => {
    console.log(`🚀 VowVista server running on port ${port}`);
  });
}

startServer();