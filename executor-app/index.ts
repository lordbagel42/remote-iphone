import {
  boolean,
  defineApp,
  defineProvider,
  json,
  mutation,
  number,
  object,
  plain,
  query,
  router,
  secrets,
  string,
  type MutationContext,
  type QueryContext,
} from "apps";

// Same definition as the Infisical provider other apps use, so the existing account links.
const infisical = defineProvider({
  name: "Infisical",
  hosts: ["*.infisical.com"],
  auth: {
    universalAuth: secrets({
      label: "Universal Auth machine identity",
      fields: object({
        clientId: plain(string({ minLength: 1 })),
        clientSecret: string({ minLength: 1 }),
        siteUrl: plain(string()).optional(),
      }),
    }),
  },
});
const requirements = { user: { accounts: { infisical } } };
type Context = QueryContext<typeof requirements> | MutationContext<typeof requirements>;

const ORIGIN = "https://iphone.bagelindustries.com";
const PROJECT = "923d970a-8e38-48f5-8c38-e7197c1ce36c";

// The phone API's bearer token lives in Infisical (prod, /iphone-wda/IPHONE_API_TOKEN).
async function apiToken(ctx: Context): Promise<string> {
  const account = ctx.user.accounts.infisical;
  const site = new URL(account.fields.siteUrl?.trim() || "https://app.infisical.com");
  if (site.protocol !== "https:" || site.username || site.password || !site.hostname.endsWith(".infisical.com"))
    throw new Error("Expected an Infisical Cloud HTTPS account.");
  const login = await ctx.fetch(`${site.origin}/api/v1/auth/universal-auth/login`, {
    method: "POST",
    redirect: "manual",
    signal: ctx.signal,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ clientId: account.fields.clientId, clientSecret: account.fields.clientSecret }),
  });
  if (!login.ok) throw new Error(`Infisical authentication failed (HTTP ${login.status}).`);
  const auth = (await login.json()) as { accessToken?: string };
  if (!auth.accessToken) throw new Error("Infisical returned no access token.");
  const url = new URL("/api/v4/secrets/IPHONE_API_TOKEN", site.origin);
  url.search = new URLSearchParams({
    projectId: PROJECT,
    environment: "prod",
    secretPath: "/iphone-wda",
    type: "shared",
    viewSecretValue: "true",
  }).toString();
  const response = await ctx.fetch(url.href, {
    redirect: "manual",
    signal: ctx.signal,
    headers: { Authorization: `Bearer ${auth.accessToken}` },
  });
  if (!response.ok) throw new Error(`Cannot read the iPhone API token (HTTP ${response.status}).`);
  const body = (await response.json()) as { secret?: { secretValue?: string } };
  if (!body.secret?.secretValue) throw new Error("The iPhone API token is missing.");
  return body.secret.secretValue;
}

async function phone(ctx: Context, method: "GET" | "POST", path: string, body?: unknown): Promise<Response> {
  const response = await ctx.fetch(`${ORIGIN}${path}`, {
    method,
    redirect: "manual",
    signal: ctx.signal,
    headers: {
      Authorization: `Bearer ${await apiToken(ctx)}`,
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!response.ok) {
    let message = `HTTP ${response.status}`;
    try {
      message = ((await response.json()) as { error?: string }).error ?? message;
    } catch {
      // not JSON
    }
    if (response.status === 503 || response.status === 502)
      message += ". WebDriverAgent is not running right now (the phone may be rebooting); retry in a minute.";
    throw new Error(`iPhone: ${message}`);
  }
  return response;
}

async function value(ctx: Context, method: "GET" | "POST", path: string, body?: unknown) {
  return ((await (await phone(ctx, method, path, body)).json()) as { value?: unknown }).value ?? null;
}

const Ok = object({ ok: boolean() });
const done = { ok: true };

export default defineApp(requirements, {
  tools: router(
    {
      status: query(
        { description: "WebDriverAgent status and the frontmost app's bundle ID.", input: object({}), output: json() },
        async (ctx) => value(ctx, "GET", "/status"),
      ),
      screenshot: query(
        {
          description:
            "Take a screenshot. Returns a JPEG URL (valid 10 minutes, no auth needed) to open with your image tool. Its pixels are screen points, the same coordinates tap and swipe use.",
          input: object({}),
          output: object({ url: string(), width: number(), height: number(), expires_in: number() }),
        },
        async (ctx) =>
          (await value(ctx, "POST", "/screenshot/link")) as {
            url: string;
            width: number;
            height: number;
            expires_in: number;
          },
      ),
      ui_tree: query(
        {
          description:
            "Accessibility tree of the current screen. compact (default) lists visible text and controls with their tap point; xml, json and description are WDA's raw formats.",
          input: object({
            format: string({ description: "compact, xml, json or description" }).default("compact"),
          }),
          output: string(),
        },
        async (ctx, { format }) =>
          (await phone(ctx, "GET", `/ui?format=${encodeURIComponent(format)}`)).text(),
      ),
      tap: mutation(
        {
          description:
            "Tap at screen-point coordinates (x and y), or tap the element whose label, name or value is exactly text.",
          input: object({
            x: number().optional(),
            y: number().optional(),
            text: string({ description: "Exact label, name or value of the element" }).optional(),
          }),
          output: json(),
        },
        async (ctx, { x, y, text }) => {
          if (text !== undefined) return value(ctx, "POST", "/tap", { text });
          if (x === undefined || y === undefined) throw new Error("Pass x and y, or text.");
          await value(ctx, "POST", "/tap", { x, y });
          return done;
        },
      ),
      swipe: mutation(
        {
          description: "Swipe or drag between two screen points. To scroll down, swipe from lower on the screen to higher.",
          input: object({
            from_x: number(),
            from_y: number(),
            to_x: number(),
            to_y: number(),
            duration: number({ description: "Seconds" }).default(0.2),
          }),
          output: Ok,
        },
        async (ctx, input) => {
          await value(ctx, "POST", "/swipe", input);
          return done;
        },
      ),
      type_text: mutation(
        {
          description: 'Type into the focused field (tap the field first). Use "\\n" for return.',
          input: object({ text: string() }),
          output: Ok,
        },
        async (ctx, { text }) => {
          await value(ctx, "POST", "/type", { text });
          return done;
        },
      ),
      press_button: mutation(
        {
          description: "Press a hardware button. unlock only wakes the screen; it cannot enter a passcode.",
          input: object({
            button: string({ description: "home, volumeup, volumedown, lock or unlock" }),
          }),
          output: Ok,
        },
        async (ctx, { button }) => {
          await value(ctx, "POST", "/press", { button });
          return done;
        },
      ),
      launch_app: mutation(
        {
          description:
            "Open an app by bundle ID, such as com.apple.Preferences or com.apple.mobilesafari. restart relaunches it from scratch.",
          input: object({ bundle_id: string({ minLength: 1 }), restart: boolean().default(false) }),
          output: Ok,
        },
        async (ctx, input) => {
          await value(ctx, "POST", "/launch", input);
          return done;
        },
      ),
      go_home: mutation(
        { description: "Go to the home screen.", input: object({}), output: Ok },
        async (ctx) => {
          await value(ctx, "POST", "/home");
          return done;
        },
      ),
    },
    {
      title: "iPhone",
      description: "Control raygen's test iPhone (iPhone SE, iOS 18) through WebDriverAgent.",
      instructions: `
Look before you act: call ui_tree (cheap, has tap points) or screenshot, then act, then look again to confirm.
Coordinates are screen points (375x667); screenshot images use the same scale.
Prefer tap with text when the element has a label; use coordinates otherwise.
screenshot returns a URL, not image bytes; open it with your image-viewing tool.
Only one agent should drive the phone at a time. A 503 error means WebDriverAgent is restarting; wait a minute and retry.
`,
    },
  ),
});
