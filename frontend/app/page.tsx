'use client';
import OnboardingForm from './OnboardingForm';

export default function Page() {
  return (
    <main style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', backgroundColor: '#0f172a', padding: '20px' }}>
      <OnboardingForm />
    </main>
  );
}
