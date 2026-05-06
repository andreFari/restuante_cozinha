import dotenv from "dotenv";
import fs from "fs";
import http from "http";
import path from "path";
import express from "express";
import morgan from "morgan";
import session from "express-session";
import { fileURLToPath } from "url";
import { Server } from "socket.io";
import cors from 'cors';
import moloniRoutes from "./routes/moloni.js";
import artigosRoutes from "./routes/artigos.js";
import moloniAuthRoutes, {
  mountMoloniBrowserAuth,
} from "./routes/moloni.auth.routes.js";
import moloniCoreRoutes from "./routes/moloni.core.routes.js";
import printingRoutes from "./routes/printing.routes.js";
import restaurantRoutes from "./routes/restaurant.routes.js";
import { printersService } from "./services/printers.service.js";
dotenv.config();

const PORT = Number(process.env.PORT || 10000);
const SESSION_SECRET = process.env.SESSION_SECRET || "chave-super-secreta";

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const uploadsDir = path.join(__dirname, "uploads");

if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
}

app.use(express.urlencoded({ extended: true, limit: '15mb' }));
app.use(express.json({ limit: '15mb' }));
app.use(morgan("dev"));
app.use(
  session({
    secret: SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: { httpOnly: true },
  }),
);
app.use(cors({
  origin: [
    'http://192.168.68.51:5173',
    'http://localhost:5173',
    'http://127.0.0.1:5173',
  ],
  methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  credentials: false,
}));


const protectedPages = new Set([
  "/rececaoBar.html",
  "/rececaoCozi.html",
  "/takeway.html",
  "/cozinha.html",
  "/faturas.html",
  "/artigos.html",
  "/menu.html",
  "/gest_mesas.html",
  "/trabalhadores.html",
]);
const adminOnlyPages = new Set(["/menu.html", "/gest_mesas.html", "/trabalhadores.html"]);

app.use((req, res, next) => {
  if (!protectedPages.has(req.path)) return next();

  const auth = req.session?.restaurantAuth || null;
  if (!auth?.user_id) {
    return res.redirect("/login.html");
  }

  if (adminOnlyPages.has(req.path) && auth.role !== "admin") {
    return res.redirect("/rececaoCozi.html");
  }

  return next();
});

app.use("/images", express.static(path.join(__dirname, "public", "imagens")));
app.use("/uploads", express.static(uploadsDir));
app.use(express.static(path.join(__dirname, "public")));

app.get("/", (req, res) => res.redirect("/login.html"));
app.get("/login.html", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "login.html"));
});

mountMoloniBrowserAuth(app);
printersService.initPrintingSockets(io, process.env.AGENT_TOKEN);

app.use("/molo", moloniRoutes);
app.use("/artigo", artigosRoutes);
app.use("/api", moloniAuthRoutes);
app.use("/api", moloniCoreRoutes);
app.use("/api", printingRoutes);
app.use("/api/restaurant", restaurantRoutes);

server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
