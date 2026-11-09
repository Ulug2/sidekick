// What counts as one "site" for approvals, sharing checks and shortcuts: the registrable domain
// from the full Public Suffix List (tldts, including its private section of shared hosts), so
// "boards.greenhouse.io" and "job-boards.greenhouse.io" are one site (greenhouse.io), and
// "alice.github.io" and "evil.github.io" are two.
import { getDomain } from "tldts";

// Hosting domains where every subdomain belongs to someone else. Most are in the Public Suffix
// List already; the ones that aren't (medium.com, substack.com, tumblr.com, …) are kept here, so
// approving one person's page never covers another's.
export const SHARED_HOSTS = new Set(["github.io", "gitlab.io", "bitbucket.io", "vercel.app", "now.sh", "netlify.app", "netlify.com", "pages.dev", "workers.dev",
  "herokuapp.com", "herokussl.com", "web.app", "firebaseapp.com", "appspot.com", "blogspot.com", "wordpress.com", "wixsite.com", "weebly.com",
  "squarespace.com", "myshopify.com", "azurewebsites.net", "cloudapp.net", "azurestaticapps.net", "cloudfront.net", "amazonaws.com", "s3.amazonaws.com", "elasticbeanstalk.com",
  "onrender.com", "fly.dev", "railway.app", "up.railway.app", "glitch.me", "repl.co", "replit.app", "replit.dev", "surge.sh", "ngrok.io", "ngrok-free.app", "ngrok.app",
  "trycloudflare.com", "neocities.org", "carrd.co", "webflow.io", "framer.app", "framer.website", "notion.site", "readthedocs.io", "gitbook.io",
  "deno.dev", "supabase.co", "codesandbox.io", "csb.app", "stackblitz.io", "streamlit.app", "hf.space", "translate.goog", "googleusercontent.com",
  "dyndns.org", "duckdns.org", "no-ip.org", "000webhostapp.com", "tumblr.com", "substack.com", "medium.com"]);

// The narrower of the two answers wins (both are endings of the host): the list above can't make
// a Public Suffix List site wider, and the Public Suffix List can't merge two people's pages.
export function siteOf(url: string): string {
  let host = "";
  try { host = new URL(url).hostname.toLowerCase(); } catch { host = String(url || "").toLowerCase(); }
  host = host.replace(/^www\./, "").replace(/^\[|\]$/g, "").replace(/\.$/, "");
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host) || host.includes(":")) return host; // IP addresses stay whole
  const psl = getDomain(host, { allowPrivateDomains: true, extractHostname: false }) || host; // a bare suffix ("github.io") is its own site
  const parts = host.split(".");
  let shared = "";
  for (let n = Math.min(3, parts.length - 1); n >= 2 && !shared; n--) {
    if (SHARED_HOSTS.has(parts.slice(-n).join("."))) shared = parts.slice(-(n + 1)).join(".");
  }
  return shared.split(".").length > psl.split(".").length ? shared : psl;
}
