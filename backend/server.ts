import express, { Request, Response, NextFunction } from 'express';
import cors from 'cors';
import { hashPassword, verifyPassword, generateToken } from './authService';
import jwt from 'jsonwebtoken';

const app = express();
const PORT = process.env.PORT || 5000;
const JWT_SECRET = process.env.JWT_SECRET || 'datanexus_super_secure_vault_key_2026';

app.use(cors({ origin: 'http://localhost:3000' }));
app.use(express.json());

// A completely clean, dynamic in-memory database store
const mockOperatorsDatabase: any[] = [];

// 🔐 CUSTOM MIDDLEWARE: Protects sensitive infrastructure deployment paths
interface AuthenticatedRequest extends Request {
  user?: any;
}

function authenticateToken(req: AuthenticatedRequest, res: Response, next: NextFunction): void {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.startsWith('Bearer ') ? authHeader.split(' ')[1] : authHeader;

  if (!token) {
    res.status(401).json({ success: false, message: "Access Denied: Missing digital identity token." });
    return;
  }

  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (err) {
      res.status(403).json({ success: false, message: "Access Denied: Your identity token has expired or is invalid." });
      return;
    }
    req.user = user;
    next();
  });
}

// 📝 PUBLIC API ROUTE: Administrative Operator Registration Portal
app.post('/api/auth/register', async (req: Request, res: Response): Promise<void> => {
  const { email, password } = req.body;
  console.log(`📝 Registering new operator account for: ${email}`);

  const existingOp = mockOperatorsDatabase.find(op => op.email === email);
  if (existingOp) {
    res.status(400).json({ success: false, message: "Registration Failed: Operator email already exists." });
    return;
  }

  try {
    const secureHash = await hashPassword(password);
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
  } catch (error) {
    res.status(500).json({ success: false, message: "Internal Hashing Server Error" });
  }
});

// 🚪 PUBLIC API ROUTE: Operator Sign-in Portal
app.post('/api/auth/login', async (req: Request, res: Response): Promise<void> => {
  const { email, password } = req.body;
  console.log(`🔑 Login attempt captured for operator: ${email}`);

  const operator = mockOperatorsDatabase.find(op => op.email === email);
  if (!operator) {
    res.status(401).json({ success: false, message: "Authentication Failed: Account does not exist." });
    return;
  }

  const isMatch = await verifyPassword(password, operator.passwordHash);
  if (!isMatch) {
    res.status(401).json({ success: false, message: "Authentication Failed: Invalid password." });
    return;
  }

  const accessToken = generateToken(operator.id, operator.email);
  console.log(`🎟️ Secure JWT Token successfully dispatched for: ${email}`);

  res.status(200).json({
    success: true,
    message: "Operator authentication successful!",
    accessToken
  });
});

// 🌐 ARMORED API ROUTE: Secure infrastructure onboarding payload
app.post('/api/tenants/onboard', authenticateToken, async (req: AuthenticatedRequest, res: Response): Promise<void> => {
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
