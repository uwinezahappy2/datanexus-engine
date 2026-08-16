import React, { useState } from 'react';

export default function OnboardingForm() {
  const [legalName, setLegalName] = useState('');
  const [tenantCode, setTenantCode] = useState('');
  const [residencyZone, setResidencyZone] = useState('EU');
  const [billingAccountId, setBillingAccountId] = useState('');
  const [statusMessage, setStatusMessage] = useState('');
  const [responseData, setResponseData] = useState<any>(null);

  const handleOnboardSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setStatusMessage('⌛ Transmitting onboarding matrix payload...');
    setResponseData(null);

    try {
      const response = await fetch('http://localhost:5000/api/tenants/onboard', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ legalName, tenantCode, residencyZone, billingAccountId }),
      });

      const json = await response.json();
      if (json.success) {
        setStatusMessage('🎉 Enterprise Workspace Isolated Successfully!');
        setResponseData(json.data);
      } else {
        setStatusMessage(`❌ Error: ${json.message}`);
      }
    } catch (err) {
      setStatusMessage('❌ Network timeout: Make sure your backend API server is running on port 5000!');
    }
  };

  return (
    <div style={{ maxWidth: '500px', margin: '40px auto', padding: '24px', background: '#1e293b', color: '#f8fafc', borderRadius: '12px', fontFamily: 'sans-serif', boxShadow: '0 4px 6px -1px rgb(0 0 0 / 0.1)' }}>
      <h2 style={{ marginTop: 0, color: '#38bdf8' }}>🌐 DataNexus Client Onboarding Portal</h2>
      <p style={{ fontSize: '14px', color: '#94a3b8' }}>Provision regional GKE namespaces and isolated BigQuery data cores.</p>
      
      <form onSubmit={handleOnboardSubmit} style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
        <div>
          <label style={{ display: 'block', marginBottom: '6px', fontSize: '14px' }}>Enterprise Legal Name</label>
          <input type="text" value={legalName} onChange={(e) => setLegalName(e.target.value)} required placeholder="e.g. Acme Logistics Global Ltd" style={{ width: '100%', padding: '10px', borderRadius: '6px', border: '1px solid #475569', background: '#0f172a', color: '#fff', boxSizing: 'border-box' }} />
        </div>

        <div>
          <label style={{ display: 'block', marginBottom: '6px', fontSize: '14px' }}>Unique Tenant Code (Shorthand)</label>
          <input type="text" value={tenantCode} onChange={(e) => setTenantCode(e.target.value)} required placeholder="e.g. ACME_LOGISTICS" style={{ width: '100%', padding: '10px', borderRadius: '6px', border: '1px solid #475569', background: '#0f172a', color: '#fff', boxSizing: 'border-box' }} />
        </div>

        <div>
          <label style={{ display: 'block', marginBottom: '6px', fontSize: '14px' }}>Data Residency Target Region</label>
          <select value={residencyZone} onChange={(e) => setResidencyZone(e.target.value)} style={{ width: '100%', padding: '10px', borderRadius: '6px', border: '1px solid #475569', background: '#0f172a', color: '#fff', boxSizing: 'border-box' }}>
            <option value="EU">EU (European Union)</option>
            <option value="US-EAST">US-East (N. Virginia)</option>
            <option value="US-WEST">US-West (Oregon)</option>
            <option value="APAC-SOUTH">APAC-South (Mumbai)</option>
          </select>
        </div>

        <div>
          <label style={{ display: 'block', marginBottom: '6px', fontSize: '14px' }}>Cloud Billing Account ID</label>
          <input type="text" value={billingAccountId} onChange={(e) => setBillingAccountId(e.target.value)} required placeholder="e.g. BILL-2026-X892" style={{ width: '100%', padding: '10px', borderRadius: '6px', border: '1px solid #475569', background: '#0f172a', color: '#fff', boxSizing: 'border-box' }} />
        </div>

        <button type="submit" style={{ padding: '12px', background: '#0284c7', color: '#fff', border: 'none', borderRadius: '6px', fontWeight: 'bold', cursor: 'pointer', transition: 'background 0.2s' }}>Initialize Isolation Layer</button>
      </form>

      {statusMessage && <div style={{ marginTop: '20px', padding: '12px', borderRadius: '6px', background: '#334155', fontSize: '14px', lineHeight: '1.5' }}>{statusMessage}</div>}
      
      {responseData && (
        <div style={{ marginTop: '16px', padding: '12px', borderRadius: '6px', background: '#0f172a', border: '1px solid #22c55e' }}>
          <h4 style={{ margin: '0 0 8px 0', color: '#22c55e' }}>🚀 Infrastructure Keys Generated:</h4>
          <pre style={{ margin: 0, fontSize: '12px', overflowX: 'auto', color: '#a7f3d0' }}>{JSON.stringify(responseData, null, 2)}</pre>
        </div>
      )}
    </div>
  );
}
