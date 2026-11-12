import type { ConnectionVerification } from '../types';
/** Connection identity only: selecting another discovered model does not invalidate a list check. Never expose this hash. */
export async function getVerificationFingerprint(config:Record<string,unknown>,network:Record<string,unknown>={}):Promise<string>{
    const identity=['baseUrl','type','framework','apiKey','username','password'].map(key=>config[key]??null);
    identity.push(network.proxyUrl??null,network.proxyBypass??null);
    const bytes=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify(identity)));
    return Array.from(new Uint8Array(bytes),byte=>byte.toString(16).padStart(2,'0')).join('');
}
export async function attestConnection(config:Record<string,unknown>,network:Record<string,unknown>={}):Promise<ConnectionVerification>{
    return {verifiedAt:Date.now(),fingerprint:await getVerificationFingerprint(config,network)};
}
