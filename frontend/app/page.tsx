'use client';

import React, { useState } from 'react';

export default function DataNexusOperatorDashboard() {
  const [email, setEmail] = useState('admin@datanexus.io');
  const [password, setPassword] = useState('secure_admin123');
  const [token, setToken] = useState('');
  
  const [legalName, setLegalName] = useState('Acme Logistics Ltd');
  const [tenantCode, setTenantCode] = useState('ACME_LOGISTICS');
  const [residencyZone, setResidencyZone] = useState('EU');
  const [billingAccountId, setBillingAccountId] = useState('BILL-2026-X892');

  const [logs, setLogs] = useState<string[]>(['🎯 DataNexus Portal Initialized: Ready to orchestrate global parameters...']);
  const [isLoading, setIsLoading] = useState(false);

  const BACKEND_URL = 'https://datanexus-backend-api.onrender.com';


  const addLog = (msg: string) => {
    setLogs((prev) => [`[${new Date().toLocaleTimeString()}] ${msg}`, ...prev]);
  };

  const handleSystemLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsLoading(true);
    addLog(`🔑 Dispatching authorization payload to: ${BACKEND_URL}/api/auth/login`);

    try {
      await fetch(`${BACKEND_URL}/api/auth/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password }),
      });

      const response = await fetch(`${BACKEND_URL}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password }),
      });

      const result = await response.json();

      if (result.success && result.accessToken) {
        setToken(result.accessToken);
        addLog(`🎟️ Secure JWT Token generated successfully! Signature cached securely.`);
      } else {
        addLog(`❌ Security Rejection: ${result.message || 'Invalid operational credentials.'}`);
      }
    } catch (err) {
      addLog(`❌ Network Error connecting to live API node.`);
    } finally {
      setIsLoading(false);
    }
  };

  const handleOnboardTenant = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!token) {
      addLog('⚠️ Operation Intercepted: You must fetch a secure JWT token.');
      return;
    }

    setIsLoading(true);
    addLog(`📥 Sending structural parameter map for tenant code: [${tenantCode}]`);

    try {
      const response = await fetch(`${BACKEND_URL}/api/tenants/onboard`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': token,
        },
        body: JSON.stringify({ legalName, tenantCode, residencyZone, billingAccountId }),
      });

      const result = await response.json();

      if (result.success) {
        addLog(`🎉 SUCCESS: Structural isolation matrix compiled!`);
        addLog(`📁 Target path generated: ${result.data.generatedManifestPath}`);
        addLog(`🛡️ Partition Namespace assigned: ${result.data.gkeNamespace}`);
      } else {
        addLog(`❌ Infrastructure Error: ${result.message}`);
      }
    } catch (err) {
      addLog(`❌ Network Connection Error.`);
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div style={{ backgroundColor: '#0f172a', color: '#f8fafc', minHeight: '100vh', padding: '40px', fontFamily: 'monospace' }}>
      <header style={{ borderBottom: '2px solid #1e293b', paddingBottom: '20px', marginBottom: '40px' }}>
        <h1 style={{ color: '#0284c7', fontSize: '28px', margin: 0 }}>⚡ DATANEXUS ENGINE</h1>
        <p style={{ color: '#94a3b8', fontSize: '13px', marginTop: '5px' }}>Production Multi-Tenant Orchestration Console Plane</p>
      </header>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '30px' }}>
        <div>
          <div style={{ backgroundColor: '#1e293b', padding: '25px', borderRadius: '8px', marginBottom: '30px', border: token ? '1px solid #22c55e' : '1px solid #334155' }}>
            <h2 style={{ fontSize: '16px', color: '#38bdf8', marginTop: 0 }}>🔐 [STEP 1] ADMIN OPERATOR AUTHENTICATION</h2>
            <form onSubmit={handleSystemLogin} style={{ marginTop: '20px' }}>
              <div style={{ marginBottom: '15px' }}>
                <label style={{ display: 'block', fontSize: '12px', color: '#94a3b8' }}>SYSTEM EMAIL ADDRESS</label>
                <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} style={{ width: '100%', backgroundColor: '#0f172a', border: '1px solid #475569', padding: '10px', color: '#fff', borderRadius: '4px', marginTop: '5px' }} required />
              </div>
              <div style={{ marginBottom: '20px' }}>
                <label style={{ display: 'block', fontSize: '12px', color: '#94a3b8' }}>CRYPTOGRAPHIC PASSWORD</label>
                <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} style={{ width: '100%', backgroundColor: '#0f172a', border: '1px solid #475569', padding: '10px', color: '#fff', borderRadius: '4px', marginTop: '5px' }} required />
              </div>
              <button type="submit" disabled={isLoading} style={{ backgroundColor: token ? '#15803d' : '#0284c7', color: '#fff', border: 'none', padding: '12px 20px', borderRadius: '4px', cursor: 'pointer', fontWeight: 'bold', width: '100%' }}>
                {token ? '⚡ JWT TOKEN CACHED (RE-AUTHENTICATE)' : '🔑 GENERATE SECURE TOKEN'}
              </button>
            </form>
          </div>

          <div style={{ backgroundColor: '#1e293b', padding: '25px', borderRadius: '8px', border: '1px solid #334155' }}>
            <h2 style={{ fontSize: '16px', color: '#38bdf8', marginTop: 0 }}>🌐 [STEP 2] LIVE TENANT ONBOARDING ENGINE</h2>
            <form onSubmit={handleOnboardTenant} style={{ marginTop: '20px' }}>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '15px', marginBottom: '15px' }}>
                <div>
                  <label style={{ fontSize: '11px', color: '#94a3b8' }}>LEGAL ENTERPRISE NAME</label>
                  <input type="text" value={legalName} onChange={(e) => setLegalName(e.target.value)} style={{ width: '100%', backgroundColor: '#0f172a', border: '1px solid #475569', padding: '10px', color: '#fff', borderRadius: '4px', marginTop: '5px' }} required />
                </div>
                <div>
                  <label style={{ fontSize: '11px', color: '#94a3b8' }}>UNIQUE TENANT CODE</label>
                  <input type="text" value={tenantCode} onChange={(e) => setTenantCode(e.target.value)} style={{ width: '100%', backgroundColor: '#0f172a', border: '1px solid #475569', padding: '10px', color: '#fff', borderRadius: '4px', marginTop: '5px' }} required />
                </div>
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '15px', marginBottom: '20px' }}>
                <div>
                  <label style={{ fontSize: '11px', color: '#94a3b8' }}>DATA RESIDENCY COMPLIANCE ZONE</label>
                  <select value={residencyZone} onChange={(e) => setResidencyZone(e.target.value)} style={{ width: '100%', backgroundColor: '#0f172a', border: '1px solid #475569', padding: '10px', color: '#fff', borderRadius: '4px', marginTop: '5px' }}>
                    <option value="EU">European Union (GDPR)</option>
                    <option value="US">United States (HIPAA)</option>
                    <option value="AF">Africa Data Sovereignty</option>
                  </select>
                </div>
                <div>
                  <label style={{ fontSize: '11px', color: '#94a3b8' }}>BILLING ACCOUNT ROUTE ID</label>
                  <input type="text" value={billingAccountId} onChange={(e) => setBillingAccountId(e.target.value)} style={{ width: '100%', backgroundColor: '#0f172a', border: '1px solid #475569', padding: '10px', color: '#fff', borderRadius: '4px', marginTop: '5px' }} required />
                </div>
              </div>
              <button type="submit" disabled={isLoading || !token} style={{ backgroundColor: !token ? '#475569' : '#16a34a', color: '#fff', border: 'none', padding: '12px 20px', borderRadius: '4px', cursor: !token ? 'not-allowed' : 'pointer', fontWeight: 'bold', width: '100%' }}>
                ⚙️ RUN AUTOMATED INFRASTRUCTURE COMPILATION
              </button>
            </form>
          </div>
        </div>

        <div style={{ display: 'flex', flexDirection: 'column' }}>
          <div style={{ flex: 1, backgroundColor: '#020617', borderRadius: '8px', padding: '25px', border: '1px solid #1e293b' }}>
            <h2 style={{ fontSize: '14px', color: '#22c55e', marginTop: 0, borderBottom: '1px solid #1e293b', paddingBottom: '10px' }}>📟 SYSTEM REFINERY PRODUCTION LOG OUTPUT</h2>
            <div style={{ height: '420px', overflowY: 'auto', marginTop: '15px', display: 'flex', flexDirection: 'column', gap: '8px', fontSize: '12px' }}>
              {logs.map((log, index) => (
                <div key={index} style={{ color: log.includes('❌') ? '#ef4444' : log.includes('🎉') ? '#22c55e' : log.includes('🎟️') ? '#a855f7' : '#e2e8f0', lineHeight: '1.5' }}>
                  {log}
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
