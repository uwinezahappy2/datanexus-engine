import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';

// In a real production deployment, this secret would load safely from your GCP Secret Manager
const JWT_SECRET = process.env.JWT_SECRET || 'datanexus_super_secure_vault_key_2026';

/**
 * Secures a raw text password using a high-entropy salt work factor
 */
export async function hashPassword(password: string): Promise<string> {
  const saltRounds = 10;
  return await bcrypt.hash(password, saltRounds);
}

/**
 * Verifies a login attempt password against the encrypted database hash string
 */
export async function verifyPassword(password: string, hash: string): Promise<boolean> {
  return await bcrypt.compare(password, hash);
}

/**
 * Issues a digitally signed, time-locked JSON Web Token for authenticated operators
 */
export function generateToken(operatorId: string, email: string): string {
  return jwt.sign(
    { operatorId, email, role: 'SYSTEM_ADMIN' },
    JWT_SECRET,
    { expiresIn: '2h' } // Token automatically expires and self-destructs after 2 hours
  );
}
