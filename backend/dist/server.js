"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = __importDefault(require("express"));
const cors_1 = __importDefault(require("cors"));
const authService_1 = require("./authService");
const jsonwebtoken_1 = __importDefault(require("jsonwebtoken"));
const app = (0, express_1.default)();
const PORT = process.env.PORT || 5000;
const JWT_SECRET = process.env.JWT_SECRET || 'datanexus_super_secure_vault_key_2026';
app.use((0, cors_1.default)({ origin: 'http://localhost:3000' }));
app.use(express_1.default.json());
// A completely clean, dynamic in-memory database store
const mockOperatorsDatabase = [];
function authenticateToken(req, res, next) {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.startsWith('Bearer ') ? authHeader.split(' ')[1] : authHeader;
    if (!token) {
        res.status(401).json({ success: false, message: "Access Denied: Missing digital identity token." });
        return;
    }
    jsonwebtoken_1.default.verify(token, JWT_SECRET, (err, user) => {
        if (err) {
            res.status(403).json({ success: false, message: "Access Denied: Your identity token has expired or is invalid." });
            return;
        }
        req.user = user;
        next();
    });
}
// 📝 PUBLIC API ROUTE: Administrative Operator Registration Portal
app.post('/api/auth/register', async (req, res) => {
    const { email, password } = req.body;
    console.log(`📝 Registering new operator account for: ${email}`);
    const existingOp = mockOperatorsDatabase.find(op => op.email === email);
    if (existingOp) {
        res.status(400).json({ success: false, message: "Registration Failed: Operator email already exists." });
        return;
    }
    try {
        const secureHash = await (0, authService_1.hashPassword)(password);
        const newOperator = {
            id: `op-${Math.floor(Math.random() * 1000)}`,
            email,
            passwordHash: secureHash
        };
        mockOperatorsDatabase.push(newOperator);
        console.log(`🔒 Account successfully encrypted for: ${email}`);
        res.status(201).json({
            success: true,
            message: "Operator database account provisioned and encrypted successfully!",
            operatorId: newOperator.id
        });
    }
    catch (error) {
        res.status(500).json({ success: false, message: "Internal Hashing Server Error" });
    }
});
// 🚪 PUBLIC API ROUTE: Operator Sign-in Portal
app.post('/api/auth/login', async (req, res) => {
    const { email, password } = req.body;
    console.log(`🔑 Login attempt captured for operator: ${email}`);
    const operator = mockOperatorsDatabase.find(op => op.email === email);
    if (!operator) {
        res.status(401).json({ success: false, message: "Authentication Failed: Account does not exist." });
        return;
    }
    const isMatch = await (0, authService_1.verifyPassword)(password, operator.passwordHash);
    if (!isMatch) {
        res.status(401).json({ success: false, message: "Authentication Failed: Invalid password." });
        return;
    }
    const accessToken = (0, authService_1.generateToken)(operator.id, operator.email);
    console.log(`🎟️ Secure JWT Token successfully dispatched for: ${email}`);
    res.status(200).json({
        success: true,
        message: "Operator authentication successful!",
        accessToken
    });
});
// 🌐 ARMORED API ROUTE: Secure infrastructure onboarding payload
app.post('/api/tenants/onboard', authenticateToken, async (req, res) => {
    console.log("📥 Verified token signature! Processing onboarding payload...");
    const { legalName, tenantCode, residencyZone, billingAccountId } = req.body;
    if (!legalName || !tenantCode || !residencyZone || !billingAccountId) {
        res.status(400).json({ success: false, message: "Missing required onboarding fields." });
        return;
    }
    res.status(201).json({
        success: true,
        message: "Tenant onboarding matrix initialized securely via armored token context!",
        data: {
            tenantCode,
            gkeNamespace: `tenant-${tenantCode.toLowerCase()}`,
            bqDatasetId: `datanexus_tenant_${tenantCode.toLowerCase()}`,
            status: "PROVISIONING",
            authorizedBy: req.user.email
        }
    });
});
app.listen(PORT, () => {
    console.log(`🚀 Secure DataNexus Control Plane Server active on http://localhost:5000`);
});
