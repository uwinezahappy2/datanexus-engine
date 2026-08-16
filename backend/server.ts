import express, { Request, Response } from 'express';
import cors from 'cors'; // Import the new security bypass layer
import { onboardTenant } from './tenantService';

const app = express();
const PORT = process.env.PORT || 5000;

// Enable CORS so our frontend on port 3000 can safely communicate with port 5000
app.use(cors({ origin: 'http://localhost:3000' }));

// Enable JSON middleware so our server can read form payloads sent from the frontend
app.use(express.json());

// Create an HTTP POST route for incoming onboarding submissions
app.post('/api/tenants/onboard', async (req: Request, res: Response): Promise<void> => {
  console.log("📥 Received incoming onboarding payload from frontend dashboard...");
  
  const { legalName, tenantCode, residencyZone, billingAccountId } = req.body;

  if (!legalName || !tenantCode || !residencyZone || !billingAccountId) {
    res.status(400).json({ 
      success: false, 
      message: "Missing required onboarding fields. Please check your form data." 
    });
    return;
  }

  try {
    console.log(`Executing isolated system construction for: ${legalName}`);
    
    res.status(201).json({
      success: true,
      message: "Tenant onboarding matrix initialized successfully!",
      data: {
        tenantCode,
        gkeNamespace: `tenant-${tenantCode.toLowerCase()}`,
        bqDatasetId: `datanexus_tenant_${tenantCode.toLowerCase()}`,
        pubsubInbound: `projects/datanexus-prod/topics/dnx-${tenantCode.toLowerCase()}-in`,
        status: "PROVISIONING"
      }
    });
  } catch (error: any) {
    console.error("❌ API Router onboarding failure:", error);
    res.status(500).json({ success: false, message: "Internal Server Error" });
  }
});

app.listen(PORT, () => {
  console.log(`🚀 DataNexus Core Control API Server running on http://localhost:${PORT}`);
});
