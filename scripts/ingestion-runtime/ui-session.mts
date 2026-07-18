// Mints a disposable user + a real magic link so the browser can authenticate
// through the product's ACTUAL auth flow (/api/auth/verify sets the httpOnly
// session cookie). Prints the URL to visit. Used for the manual UI pass.
import { svc, errText } from "./lib.mts";

const TAG = "flowguide-rt-" + process.pid;
const email = `${TAG}@disposable.invalid`;

const { data: user, error: uerr } = await svc.from("users").insert({ email }).select("id").single();
if (uerr) { console.error("user:", errText(uerr)); process.exit(1); }

const token = crypto.randomUUID();
const { error: merr } = await svc.from("magic_links").insert({
  email, token, expires_at: new Date(Date.now() + 36e5).toISOString(),
});
if (merr) { console.error("magic link:", errText(merr)); process.exit(1); }

const base = process.env.FLOWGUIDE_BASE_URL || "http://localhost:3000";
console.log(JSON.stringify({ userId: user.id, email, verifyUrl: `${base}/api/auth/verify?token=${token}` }, null, 2));
