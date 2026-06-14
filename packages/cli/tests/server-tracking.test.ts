import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  affitorClientSource,
  detectPaymentProvider,
  serverTrackingSnippets,
} from "../src/lib/server-tracking";

const dirs: string[] = [];

function project(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "affitor-srv-"));
  for (const [rel, content] of Object.entries(files)) {
    const full = join(dir, rel);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, content);
  }
  dirs.push(dir);
  return dir;
}

function pkg(deps: Record<string, string>): Record<string, string> {
  return { "package.json": JSON.stringify({ dependencies: deps }) };
}

afterEach(() => {
  while (dirs.length) {
    try {
      rmSync(dirs.pop()!, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
});

describe("detectPaymentProvider", () => {
  it("detects stripe / polar / lemonsqueezy / paddle", () => {
    expect(detectPaymentProvider(project(pkg({ stripe: "17" })))).toBe("stripe");
    expect(detectPaymentProvider(project(pkg({ "@polar-sh/sdk": "0.4" })))).toBe("polar");
    expect(detectPaymentProvider(project(pkg({ "@lemonsqueezy/lemonsqueezy.js": "4" })))).toBe("lemonsqueezy");
    expect(detectPaymentProvider(project(pkg({ "@paddle/paddle-node-sdk": "1" })))).toBe("paddle");
  });

  it("returns unknown when no provider dep is present", () => {
    expect(detectPaymentProvider(project(pkg({ express: "4" })))).toBe("unknown");
    expect(detectPaymentProvider(project({}))).toBe("unknown"); // no package.json
  });
});

describe("affitorClientSource", () => {
  it("scaffolds a configured @affitor/sdk/server client reading AFFITOR_API_KEY", () => {
    const src = affitorClientSource();
    expect(src).toContain("from '@affitor/sdk/server'");
    expect(src).toContain("new Affitor({ apiKey: process.env.AFFITOR_API_KEY");
    expect(src).toContain("export const affitor");
  });
});

describe("serverTrackingSnippets", () => {
  it("lead snippet always binds customerExternalId + clickId and imports the client", () => {
    const s = serverTrackingSnippets("unknown", "@/lib/affitor");
    expect(s.lead).toContain("import { affitor } from '@/lib/affitor';");
    expect(s.lead).toContain("trackLead({ customerExternalId: user.id, clickId: cookies.affitor_click_id })");
  });

  it("Polar → order.paid + total_amount + order.id", () => {
    const s = serverTrackingSnippets("polar");
    expect(s.saleContext).toContain("order.paid");
    expect(s.sale).toContain("amount: order.total_amount");
    expect(s.sale).toContain("invoiceId: order.id");
  });

  it("Lemon Squeezy → order_created + data.attributes.total + meta.custom_data", () => {
    const s = serverTrackingSnippets("lemonsqueezy");
    expect(s.saleContext).toContain("order_created");
    expect(s.sale).toContain("amount: data.attributes.total");
    expect(s.sale).toContain("meta.custom_data");
  });

  it("unknown → generic amountInCents / transactionId", () => {
    const s = serverTrackingSnippets("unknown");
    expect(s.sale).toContain("amount: amountInCents");
    expect(s.sale).toContain("invoiceId: transactionId");
  });

  it("includes a refund snippet (trackRefund by invoiceId)", () => {
    const s = serverTrackingSnippets("polar");
    expect(s.refund).toContain("affitor.trackRefund({ invoiceId");
    expect(s.refund).toContain("refund webhook");
  });
});
