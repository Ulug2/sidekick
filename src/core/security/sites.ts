// What counts as one "site" for approvals, sharing checks and shortcuts.

// Hosting domains where every subdomain belongs to someone else (from the Public Suffix List's
// private section): alice.github.io and evil.github.io are different sites, so approving one
// must never cover the other.
export const SHARED_HOSTS = new Set(["github.io", "gitlab.io", "bitbucket.io", "vercel.app", "now.sh", "netlify.app", "netlify.com", "pages.dev", "workers.dev",
  "herokuapp.com", "herokussl.com", "web.app", "firebaseapp.com", "appspot.com", "blogspot.com", "wordpress.com", "wixsite.com", "weebly.com",
  "squarespace.com", "myshopify.com", "azurewebsites.net", "cloudapp.net", "azurestaticapps.net", "cloudfront.net", "amazonaws.com", "s3.amazonaws.com", "elasticbeanstalk.com",
  "onrender.com", "fly.dev", "railway.app", "up.railway.app", "glitch.me", "repl.co", "replit.app", "replit.dev", "surge.sh", "ngrok.io", "ngrok-free.app", "ngrok.app",
  "trycloudflare.com", "neocities.org", "carrd.co", "webflow.io", "framer.app", "framer.website", "notion.site", "readthedocs.io", "gitbook.io",
  "deno.dev", "supabase.co", "codesandbox.io", "csb.app", "stackblitz.io", "streamlit.app", "hf.space", "translate.goog", "googleusercontent.com",
  "dyndns.org", "duckdns.org", "no-ip.org", "000webhostapp.com", "tumblr.com", "substack.com", "medium.com"]);

// "boards.greenhouse.io" and "job-boards.greenhouse.io" are the same site: greenhouse.io.
// Keeps three labels for country domains like "jobs.example.co.uk", and one more label on
// shared hosting domains ("alice.github.io").
export function siteOf(url: string): string {
  let host = "";
  try { host = new URL(url).hostname.toLowerCase(); } catch { host = String(url || "").toLowerCase(); }
  host = host.replace(/^www\./, "").replace(/^\[|\]$/g, "").replace(/\.$/, "");
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host) || host.includes(":")) return host; // IP addresses stay whole
  const parts = host.split(".");
  for (let n = Math.min(3, parts.length - 1); n >= 2; n--) {
    if (SHARED_HOSTS.has(parts.slice(-n).join("."))) return parts.slice(-(n + 1)).join(".");
  }
  if (parts.length <= 2) return host;
  const sld = parts.at(-2)!;
  const keep = /^(co|com|ac|edu|gov|org|net)$/.test(sld) && parts.at(-1)!.length === 2 ? 3 : 2;
  return parts.slice(-keep).join(".");
}
