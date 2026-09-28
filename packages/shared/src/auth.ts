import { exportJWK, generateKeyPair, importJWK, jwtVerify, SignJWT, type JWK, type JWTPayload } from 'jose';
export type ContactClaims = JWTPayload & { runId: string; actions: string[] };
export async function makeKeys() {
  const pair = await generateKeyPair('EdDSA', { extractable: true });
  return { privateJwk: await exportJWK(pair.privateKey), publicJwk: await exportJWK(pair.publicKey) };
}
export async function issueContact(privateJwk: JWK, sender: string, recipient: string, runId: string, actions: string[], deadline: string) {
  return new SignJWT({ runId, actions }).setProtectedHeader({ alg: 'EdDSA', typ: 'JWT' }).setIssuer('kin-local').setSubject(sender).setAudience(recipient).setIssuedAt().setExpirationTime(Math.floor(Date.parse(deadline) / 1000)).sign(await importJWK(privateJwk, 'EdDSA'));
}
export async function verifyContact(token: string, publicJwk: JWK, recipient: string): Promise<ContactClaims> {
  const { payload } = await jwtVerify(token, await importJWK(publicJwk, 'EdDSA'), { issuer: 'kin-local', audience: recipient, algorithms: ['EdDSA'] });
  if (typeof payload.runId !== 'string' || !Array.isArray(payload.actions) || !payload.actions.every(a => typeof a === 'string') || typeof payload.sub !== 'string') throw new Error('Invalid contact authorization');
  return payload as ContactClaims;
}
