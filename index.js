import express from "express";
import cors from "cors";
import "dotenv/config";
import { MongoClient, ObjectId } from "mongodb";
import Stripe from "stripe";

const app = express();
const port = process.env.PORT || 5000;
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

// CORS সেটআপ
app.use(cors({ origin: process.env.CLIENT_URL, credentials: true }));

// Health check (সার্ভার ঠিক আছে কিনা চেক করার জন্য)
app.get("/", (req, res) => res.send("VowVista API is running 💍"));

// MongoDB connection string
const mongoUri =
  process.env.MONGODB_URI || process.env.MONGO_URI ||
  `mongodb+srv://${process.env.DB_USER}:${process.env.DB_PASSWORD}@cluster0.rffvcgh.mongodb.net/?retryWrites=true&w=majority`;

const client = new MongoClient(mongoUri);

let db;
let collections;

// ফাংশন তৈরি করলাম যাতে ডাটাবেস কানেক্ট হওয়ার পরেই collections পাওয়া যায়
async function connectDB() {
  try {
    await client.connect();
    console.log("✅ Connected to MongoDB");
    
    // কানেকশন সফল হলে db এবং collections সেট হবে
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
    process.exit(1); // কানেকশন ফেইল করলে সার্ভার বন্ধ হয়ে যাবে
  }
}

// JSON parser (webhook ছাড়া বাকি সব রুটের জন্য)
app.use(express.json());

// ==========================================
// 🔐 AUTH & ROLE MIDDLEWARES
// ==========================================

// ১. টোকেন ভেরিফাই মিডলওয়্যার
const verifyToken = async (req, res, next) => {
  const authHeader = req.headers.authorization;
  
  // টোকেন আছে কিনা চেক
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return res.status(401).send({ message: "Unauthorized: No token provided" });
  }

  const token = authHeader.split(" ")[1];

  try {
    // Better Auth-এর 'session' কালেকশনে টোকেন খুঁজছি
    const session = await collections.sessions.findOne({ token });
    if (!session) {
      return res.status(401).send({ message: "Unauthorized: Invalid or expired token" });
    }

    // টোকেন থেকে userId নিয়ে 'user' কালেকশন থেকে ডাটা বের করছি (স্ট্রিং থেকে ObjectId কনভার্ট করে)
    const user = await collections.users.findOne({ _id: new ObjectId(session.userId) });

    // ইউজার না থাকলে বা ব্লকড থাকলে আটকে দিচ্ছি
    if (!user) {
      return res.status(401).send({ message: "Unauthorized: User not found" });
    }
    if (user.isBlocked) {
      return res.status(403).send({ message: "Forbidden: Your account has been blocked" });
    }

    // সব ঠিক থাকলে ইউজারের ডাটা req.user-এ সেভ করছি
    req.user = user;
    next();
  } catch (error) {
    console.error("Token verification error:", error);
    return res.status(500).send({ message: "Internal Server Error" });
  }
};

// ২. রোল ভেরিফাই মিডলওয়্যার (Vendor, Customer, Admin)
const verifyRole = (roles) => {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).send({ message: "Unauthorized: User not authenticated" });
    }
    
    // রোল ম্যাচ করছে কিনা চেক (সিঙ্গেল বা মাল্টিপল রোল সাপোর্ট করবে)
    if (!roles.includes(req.user.role)) {
      return res.status(403).send({ message: "Forbidden: You do not have permission to access this resource" });
    }
    next();
  };
};

// ==========================================
// 💍 SERVICES ROUTES
// ==========================================

// ১. Public API: সব Approved এবং Active সার্ভিস (সার্চ, ফিল্টার, সর্ট সহ)
app.get("/services", async (req, res) => {
  try {
    const { search, category, location, sort } = req.query;
    let query = { status: "approved", isActive: true }; // রিকোয়ারমেন্ট: শুধু Approved এবং Active

    // সার্চ (সার্ভিসের নাম দিয়ে)
    if (search) {
      query.serviceName = { $regex: search, $options: "i" };
    }

    // ক্যাটাগরি ফিল্টার
    if (category) {
      query.category = category;
    }

    // লোকেশন ফিল্টার
    if (location) {
      query.location = { $regex: location, $options: "i" };
    }

    // প্রাইস সর্টিং (ascending বা descending)
    let sortOption = {};
    if (sort === "asc") sortOption.price = 1;
    if (sort === "desc") sortOption.price = -1;

    const services = await collections.services.find(query).sort(sortOption).toArray();
    res.send(services);
  } catch (error) {
    res.status(500).send({ message: "Failed to fetch services" });
  }
});

// ২. Vendor API: নিজের সব সার্ভিস দেখা (Approved, Pending, Rejected)
app.get("/services/vendor", verifyToken, verifyRole(["vendor"]), async (req, res) => {
  try {
    const services = await collections.services.find({ vendorId: req.user._id.toString() }).toArray();
    res.send(services);
  } catch (error) {
    res.status(500).send({ message: "Failed to fetch vendor services" });
  }
});

// ৩. Public API: একটি নির্দিষ্ট সার্ভিসের ডিটেইলস
app.get("/services/:id", async (req, res) => {
  try {
    const id = req.params.id;
    // Invalid ObjectId চেক
    if (!ObjectId.isValid(id)) {
      return res.status(400).send({ message: "Invalid Service ID format" });
    }

    const service = await collections.services.findOne({ _id: new ObjectId(id) });
    
    if (!service) {
      return res.status(404).send({ message: "Service not found" });
    }
    res.send(service);
  } catch (error) {
    res.status(500).send({ message: "Failed to fetch service details" });
  }
});

// ৪. Vendor API: নতুন সার্ভিস তৈরি করা
app.post("/services", verifyToken, verifyRole(["vendor"]), async (req, res) => {
  try {
    const { serviceName, category, description, price, location, images } = req.body;

    // ফ্রি প্ল্যান লিমিট চেক (Maximum 3 active services)
    if (req.user.subscriptionPlan !== "premium") {
      const activeCount = await collections.services.countDocuments({
        vendorId: req.user._id.toString(),
        isActive: true,
      });
      if (activeCount >= 3) {
        return res.status(403).send({ 
          message: "Free plan limit reached. Upgrade to Premium to publish more than 3 active services." 
        });
      }
    }

    const newService = {
      vendorId: req.user._id.toString(), // সার্ভার নিজে সেট করছে, ক্লায়েন্টের ওপর ভরসা না করে
      serviceName,
      category,
      description,
      price: Number(price),
      location,
      images: images || [], // ImgBB থেকে আসা ইমেজ URL
      status: "pending",    // ডিফল্ট স্ট্যাটাস
      isActive: true,
      createdAt: new Date(),
    };

    const result = await collections.services.insertOne(newService);
    res.status(201).send(result);
  } catch (error) {
    res.status(500).send({ message: "Failed to create service" });
  }
});

// ৫. Vendor API: নিজের সার্ভিস আপডেট করা
app.patch("/services/:id", verifyToken, verifyRole(["vendor"]), async (req, res) => {
  try {
    const id = req.params.id;
    if (!ObjectId.isValid(id)) return res.status(400).send({ message: "Invalid Service ID" });

    const service = await collections.services.findOne({ _id: new ObjectId(id) });
    if (!service) return res.status(404).send({ message: "Service not found" });

    // Ownership Check: নিজের সার্ভিস কিনা
    if (service.vendorId !== req.user._id.toString()) {
      return res.status(403).send({ message: "Forbidden: You can only update your own services" });
    }

    // আপডেট ডাটা (vendorId বা status ক্লায়েন্ট পরিবর্তন করতে পারবে না, শুধু নির্দিষ্ট ফিল্ড)
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

// ৬. Vendor API: নিজের সার্ভিস ডিলিট করা
app.delete("/services/:id", verifyToken, verifyRole(["vendor"]), async (req, res) => {
  try {
    const id = req.params.id;
    if (!ObjectId.isValid(id)) return res.status(400).send({ message: "Invalid Service ID" });

    const service = await collections.services.findOne({ _id: new ObjectId(id) });
    if (!service) return res.status(404).send({ message: "Service not found" });

    // Ownership Check
    if (service.vendorId !== req.user._id.toString()) {
      return res.status(403).send({ message: "Forbidden: You can only delete your own services" });
    }

    const result = await collections.services.deleteOne({ _id: new ObjectId(id) });
    res.send(result);
  } catch (error) {
    res.status(500).send({ message: "Failed to delete service" });
  }
});

// ৭. Admin API: সার্ভিস Approve / Reject করা
app.patch("/services/:id/status", verifyToken, verifyRole(["admin"]), async (req, res) => {
  try {
    const id = req.params.id;
    const { status } = req.body; // "approved" অথবা "rejected"

    if (!["approved", "rejected"].includes(status)) {
      return res.status(400).send({ message: "Invalid status value" });
    }

    const result = await collections.services.updateOne(
      { _id: new ObjectId(id) },
      { $set: { status } }
    );
    res.send(result);
  } catch (error) {
    res.status(500).send({ message: "Failed to update service status" });
  }
});


// ==========================================
// 🚀 SERVER START
// ==========================================
async function startServer() {
  await connectDB();
  
  app.listen(port, () => {
    console.log(`🚀 VowVista server running on port ${port}`);
  });
}

startServer();