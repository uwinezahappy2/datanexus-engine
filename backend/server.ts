import express, { Request, Response, NextFunction } from 'express';
import cors from 'cors';
import fs from 'fs';
import path from 'path';
import { hashPassword, verifyPassword, generateToken } from './authService';
import jwt from 'jsonwebtoken';

const app = express();
const PORT = process.env.PORT || 5000;
const JWT_SECRET = process.env.JWT_SECRET || 'datanexus_super_secure_vault_key_2026';

app.use(cors({ origin: 'http://localhost:3000' }));
app.use(express.json());

// A completely clean, dynamic in-memory database store for operator roles
const mockOperatorsDatabase: any[] = [];

// 🔐 CUSTOM MIDDLEWARE: Protects sensitive infrastructure deployment paths
interface AuthenticatedRequest extends Request {
  user?: any;
}

function authenticateToken(req: AuthenticatedRequest, res: Response, next: NextFunction): void {
  const authHeader = req.headers['authorization'];
  
  // Guard clause to handle missing auth headers cleanly
  if (!authHeader) {
    res.status(401).json({ success: false, message: "Access Denied: Missing digital identity token." });
    return;
  }

  // Handle both standard space-separated Bearer tokens and raw terminal inputs securely
  const token = authHeader.startsWith('Bearer ') ? authHeader.split(' ')[1] : authHeader;

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

// 🌐 ARMORED & AUTOMATED API ROUTE: Generates live production K8s blueprints in real-time
app.post('/api/tenants/onboard', authenticateToken, async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  console.log("📥 Verified token signature! Initializing structural isolation generator...");
  const { legalName, tenantCode, residencyZone, billingAccountId } = req.body;

  if (!legalName || !tenantCode || !residencyZone || !billingAccountId) {
    res.status(400).json({ success: false, message: "Missing required onboarding fields." });
    return;
  }

  const cleanCode = tenantCode.toUpperCase().replace(/[^A-Z0-9_]/g, '');
  const targetNamespace = `tenant-${cleanCode.toLowerCase()}`;

  // 🤖 THE INFRASTRUCTURE-AS-CODE ENGINE: This dynamically constructs a fresh Kubernetes Namespace manifest file!
  const k8sManifestContent = `apiVersion: v1
kind: Namespace
metadata:
  name: ${targetNamespace}
  labels:
    tier: tenant-isolation-layer
    compliance: data-residency-${residencyZone.toLowerCase()}
    billing-id: ${billingAccountId.toLowerCase()}
`;

  try {
    const targetFolder = path.join(__dirname, '../../infrastructure/k8s');
    
    // Ensure directory exists securely on disk
    if (!fs.existsSync(targetFolder)) {
      fs.mkdirSync(targetFolder, { recursive: true });
    }

    const targetFilePath = path.join(targetFolder, `namespace-${targetNamespace}.yaml`);
    fs.writeFileSync(targetFilePath, k8sManifestContent, 'utf8');
    console.log(`🛠️ Automated Cloud Mapping Complete: Saved production GKE manifest to ${targetFilePath}`);

    res.status(201).json({
      success: true,
      message: "Tenant infrastructure isolation matrix generated and written to disk successfully!",
      data: {
        tenantCode: cleanCode,
        gkeNamespace: targetNamespace,
        bqDatasetId: `datanexus_tenant_${cleanCode.toLowerCase()}`,
        generatedManifestPath: `infrastructure/k8s/namespace-${targetNamespace}.yaml`,
        status: "PROVISIONING_MANIFEST_READY",
        authorizedBy: req.user.email
      }
    });
  } catch (error) {
    console.error("❌ Infrastructure writing error:", error);
    res.status(500).json({ success: false, message: "Internal Cloud Manifest Generation Failure" });
  }
});

app.listen(PORT, () => {
  console.log(`🚀 Secure DataNexus Control Plane Server active on http://localhost:5000`);
});
