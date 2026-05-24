import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomBytes } from "node:crypto";
import { URL } from "node:url";
import Stripe from "stripe";
import open from "open";
import * as logger from "./logger.js";
import {
  OAUTH_CALLBACK_PORT_START,
  OAUTH_CALLBACK_PORT_END,
  OAUTH_TIMEOUT_MS,
  WEBHOOK_EVENTS,
} from "../types.js";

interface OAuthResult {
  stripe_user_id: string;
  stripe_publishable_key?: string;
  access_token: string;
}

interface WebhookResult {
  webhook_endpoint_id: string;
  webhook_secret: string;
}

export interface StripeSetupResult {
  stripe_user_id: string;
  webhook_endpoint_id: string;
  webhook_secret: string;
}

export async function runStripeOAuth(opts: {
  clientId: string;
  programId: string;
  webhookUrl: string;
  stripeSecretKey: string;
}): Promise<StripeSetupResult> {
  const nonce = randomBytes(16).toString("hex");
  const state = Buffer.from(
    JSON.stringify({ program_id: opts.programId, nonce }),
  ).toString("base64url");

  const port = await findAvailablePort();
  const redirectUri = `http://localhost:${port}/callback`;

  const authCode = await startOAuthFlow({
    clientId: opts.clientId,
    redirectUri,
    state,
    nonce,
    port,
  });

  // Exchange authorization code for connected account ID
  logger.step("Exchanging authorization code...");
  const stripe = new Stripe(opts.stripeSecretKey);
  const tokenResponse = await stripe.oauth.token({
    grant_type: "authorization_code",
    code: authCode,
  });

  if (!tokenResponse.stripe_user_id) {
    throw new StripeOAuthError(
      "Stripe did not return an account ID. Authorization may have failed.",
    );
  }

  const oauthResult: OAuthResult = {
    stripe_user_id: tokenResponse.stripe_user_id,
    access_token: tokenResponse.access_token ?? "",
    stripe_publishable_key: tokenResponse.stripe_publishable_key,
  };

  logger.success("Stripe authorized");
  logger.step(`Account: ${oauthResult.stripe_user_id}`);

  const webhook = await createWebhookEndpoint({
    stripeSecretKey: opts.stripeSecretKey,
    stripeAccountId: oauthResult.stripe_user_id,
    webhookUrl: opts.webhookUrl,
  });

  logger.success("Webhook endpoint created");
  for (const event of WEBHOOK_EVENTS) {
    logger.step(`✓ ${event}`);
  }

  return {
    stripe_user_id: oauthResult.stripe_user_id,
    webhook_endpoint_id: webhook.webhook_endpoint_id,
    webhook_secret: webhook.webhook_secret,
  };
}

async function startOAuthFlow(opts: {
  clientId: string;
  redirectUri: string;
  state: string;
  nonce: string;
  port: number;
}): Promise<string> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      server.close();
      reject(
        new StripeOAuthError(
          `Timed out after ${OAUTH_TIMEOUT_MS / 1000}s waiting for Stripe authorization.\n` +
            "Run `npx affitor setup stripe` to try again.",
        ),
      );
    }, OAUTH_TIMEOUT_MS);

    const server = createServer(
      (req: IncomingMessage, res: ServerResponse) => {
        const url = new URL(req.url ?? "/", `http://localhost:${opts.port}`);

        if (url.pathname !== "/callback") {
          res.writeHead(404);
          res.end("Not found");
          return;
        }

        const error = url.searchParams.get("error");
        if (error) {
          clearTimeout(timeout);
          res.writeHead(200, { "Content-Type": "text/html" });
          res.end(errorPage("Stripe authorization was cancelled."));
          server.close();
          reject(
            new StripeOAuthError(
              `Stripe authorization cancelled: ${error}.\n` +
                "Run `npx affitor setup stripe` to try again.",
            ),
          );
          return;
        }

        const code = url.searchParams.get("code");
        const returnedState = url.searchParams.get("state");

        if (!code || returnedState !== opts.state) {
          clearTimeout(timeout);
          res.writeHead(200, { "Content-Type": "text/html" });
          res.end(errorPage("Invalid OAuth callback. Please try again."));
          server.close();
          reject(new StripeOAuthError("Invalid OAuth state parameter."));
          return;
        }

        clearTimeout(timeout);
        res.writeHead(200, { "Content-Type": "text/html" });
        res.end(
          successPage(
            "Stripe connected! You can close this tab and return to the terminal.",
          ),
        );
        server.close();

        resolve(code);
      },
    );

    server.listen(opts.port, () => {
      const authorizeUrl =
        `https://connect.stripe.com/oauth/authorize` +
        `?response_type=code` +
        `&client_id=${opts.clientId}` +
        `&scope=read_write` +
        `&redirect_uri=${encodeURIComponent(opts.redirectUri)}` +
        `&state=${opts.state}`;

      logger.info("Opening Stripe Connect in your browser...");
      logger.debug(`URL: ${authorizeUrl}`);

      open(authorizeUrl).catch(() => {
        logger.warn("Could not open browser automatically.");
        logger.info(`Open this URL manually:\n  ${authorizeUrl}`);
      });
    });

    server.on("error", (err) => {
      clearTimeout(timeout);
      reject(
        new StripeOAuthError(`Failed to start OAuth callback server: ${err.message}`),
      );
    });
  });
}

async function createWebhookEndpoint(opts: {
  stripeSecretKey: string;
  stripeAccountId: string;
  webhookUrl: string;
}): Promise<WebhookResult> {
  const stripe = new Stripe(opts.stripeSecretKey);

  const endpoint = await stripe.webhookEndpoints.create(
    {
      url: opts.webhookUrl,
      enabled_events: [...WEBHOOK_EVENTS],
      description: "Affitor affiliate tracking — auto-configured by CLI",
    },
    { stripeAccount: opts.stripeAccountId },
  );

  if (!endpoint.secret) {
    throw new StripeOAuthError(
      "Webhook endpoint created but no signing secret returned. Contact support.",
    );
  }

  return {
    webhook_endpoint_id: endpoint.id,
    webhook_secret: endpoint.secret,
  };
}

async function findAvailablePort(): Promise<number> {
  for (let port = OAUTH_CALLBACK_PORT_START; port <= OAUTH_CALLBACK_PORT_END; port++) {
    const available = await checkPort(port);
    if (available) return port;
  }
  throw new StripeOAuthError(
    `Ports ${OAUTH_CALLBACK_PORT_START}-${OAUTH_CALLBACK_PORT_END} are all in use.\n` +
      "Close other applications and try again.",
  );
}

function checkPort(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer();
    server.once("error", () => resolve(false));
    server.once("listening", () => {
      server.close(() => resolve(true));
    });
    server.listen(port);
  });
}

function successPage(message: string): string {
  return `<!DOCTYPE html>
<html><head><title>Affitor</title>
<style>body{font-family:system-ui;display:flex;justify-content:center;align-items:center;min-height:100vh;margin:0;background:#f8fafc}
.card{text-align:center;padding:2rem;border-radius:12px;background:white;box-shadow:0 1px 3px rgba(0,0,0,0.1)}
h1{color:#16a34a;font-size:1.5rem}p{color:#64748b}</style>
</head><body><div class="card"><h1>✓ ${message}</h1><p>Return to your terminal.</p></div></body></html>`;
}

function errorPage(message: string): string {
  return `<!DOCTYPE html>
<html><head><title>Affitor</title>
<style>body{font-family:system-ui;display:flex;justify-content:center;align-items:center;min-height:100vh;margin:0;background:#f8fafc}
.card{text-align:center;padding:2rem;border-radius:12px;background:white;box-shadow:0 1px 3px rgba(0,0,0,0.1)}
h1{color:#dc2626;font-size:1.5rem}p{color:#64748b}</style>
</head><body><div class="card"><h1>✗ ${message}</h1><p>Return to your terminal.</p></div></body></html>`;
}

export class StripeOAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StripeOAuthError";
  }
}
