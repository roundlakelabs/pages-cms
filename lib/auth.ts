import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { nextCookies } from "better-auth/next-js";
import { emailOTP } from "better-auth/plugins";
import { db } from "@/db";
import * as schema from "@/db/schema";
import { getBaseUrl } from "@/lib/base-url";
import { repairLegacyGithubStubOnLogin } from "@/lib/github-legacy-stub-repair";
import { sendEmail } from "@/lib/mailer";
import { syncGithubProfileOnLogin } from "@/lib/github-account";
import { bindCollaboratorInvitesToUser } from "@/lib/collaborator-access";
import { LoginEmailTemplate } from "@/components/email/login";
import { render } from "@react-email/render";
import { sql } from "drizzle-orm";

// --- Local patch: GitHub login for admins only; everyone else must be invited and use email ---
const GITHUB_CALLBACK_PATH = "/callback/:id";

const normalize = (email?: string | null) => (email || "").trim().toLowerCase();

const isAdminEmail = (email?: string | null) => {
  const admins = (process.env.ADMIN_EMAILS || "")
    .split(",")
    .map((entry) => normalize(entry))
    .filter(Boolean);
  return !!normalize(email) && admins.includes(normalize(email));
};

const isInvitedEmail = async (email?: string | null) => {
  const value = normalize(email);
  if (!value) return false;
  const collaborator = await db.query.collaboratorTable.findFirst({
    where: (table) => sql`lower(${table.email}) = ${value}`,
  });
  if (collaborator) return true;
  const invite = await db.query.collaboratorInviteTable.findFirst({
    where: (table) => sql`lower(${table.email}) = ${value}`,
  });
  return !!invite;
};

const canAuthenticate = async (email: string | null | undefined, path: string | undefined) => {
  if (path === GITHUB_CALLBACK_PATH) return isAdminEmail(email);
  return isAdminEmail(email) || (await isInvitedEmail(email));
};
// --- End local patch ---

export const auth = betterAuth({
  baseURL: getBaseUrl(),
  secret: (process.env.AUTH_SECRET || process.env.BETTER_AUTH_SECRET) as string,
  user: {
    additionalFields: {
      githubUsername: {
        type: "string",
        required: false,
        input: false,
      },
    },
  },
  account: {
    accountLinking: {
      enabled: true,
      trustedProviders: ["github"],
      disableImplicitLinking: false,
      updateUserInfoOnLink: true,
      allowUnlinkingAll: false,
    },
  },
  socialProviders: {
    github: {
      clientId: process.env.GITHUB_APP_CLIENT_ID as string,
      clientSecret: process.env.GITHUB_APP_CLIENT_SECRET as string,
      overrideUserInfoOnSignIn: false,
      mapProfileToUser: (profile) => ({
        name: profile.name ?? profile.login,
        image: profile.avatar_url ?? null,
        githubUsername: profile.login,
      }),
      scope: ["repo", "user:email"],
      getUserInfo: async (token) => {
        const profileResponse = await fetch("https://api.github.com/user", {
          headers: {
            "User-Agent": "better-auth",
            Authorization: `Bearer ${token.accessToken}`,
          },
        });

        if (!profileResponse.ok) {
          console.warn("[auth] github getUserInfo failed", {
            status: profileResponse.status,
            githubRequestId: profileResponse.headers.get("x-github-request-id"),
            rateLimitRemaining: profileResponse.headers.get("x-ratelimit-remaining"),
          });
          return null;
        }

        const profile = await profileResponse.json();

        let emails:
          | Array<{ email: string; primary: boolean; verified: boolean; visibility: "public" | "private" }>
          | undefined;
        try {
          const emailsResponse = await fetch("https://api.github.com/user/emails", {
            headers: {
              Authorization: `Bearer ${token.accessToken}`,
              "User-Agent": "better-auth",
            },
          });
          if (emailsResponse.ok) {
            emails = await emailsResponse.json();
          }
        } catch {}

        if (!profile.email && emails) {
          profile.email = (emails.find((entry) => entry.primary) ?? emails[0])?.email as string;
        }
        const emailVerified = emails?.find((entry) => entry.email === profile.email)?.verified ?? false;

        const userMap = {
          name: profile.name ?? profile.login,
          image: profile.avatar_url ?? null,
          githubUsername: profile.login,
        };

        return {
          user: {
            id: profile.id,
            email: profile.email,
            emailVerified,
            ...userMap,
          },
          data: profile,
        };
      },
    },
  },
  database: drizzleAdapter(db, {
    provider: "pg",
    schema: {
      user: schema.userTable,
      session: schema.sessionTable,
      account: schema.accountTable,
      verification: schema.verificationTable,
    },
  }),
  databaseHooks: {
    user: {
      create: {
        before: async (user, ctx) => {
          if (!(await canAuthenticate(user.email, ctx?.path))) {
            console.warn("[auth] blocked sign-up", { email: user.email, path: ctx?.path });
            return false;
          }
          return { data: user };
        },
      },
    },
    session: {
      create: {
        before: async (session, ctx) => {
          const user = await db.query.userTable.findFirst({
            where: (table, { eq }) => eq(table.id, session.userId),
          });
          if (!(await canAuthenticate(user?.email, ctx?.path))) {
            console.warn("[auth] blocked login", { email: user?.email, path: ctx?.path });
            return false;
          }
          return { data: session };
        },
        after: async (session) => {
          try {
            await repairLegacyGithubStubOnLogin(session.id, session.userId);
          } catch (error) {
            console.warn("[auth] legacy github stub repair failed", {
              sessionId: session.id,
              userId: session.userId,
              error: error instanceof Error ? error.message : String(error),
            });
          }

          try {
            await syncGithubProfileOnLogin(session.userId);
          } catch (error) {
            console.warn("[auth] github profile sync failed", {
              sessionId: session.id,
              userId: session.userId,
              error: error instanceof Error ? error.message : String(error),
            });
          }

          try {
            const user = await db.query.userTable.findFirst({
              where: (table, { eq }) => eq(table.id, session.userId),
            });
            if (user) {
              await bindCollaboratorInvitesToUser(user);
            }
          } catch (error) {
            console.warn("[auth] collaborator invite binding failed", {
              sessionId: session.id,
              userId: session.userId,
              error: error instanceof Error ? error.message : String(error),
            });
          }

        },
      },
    },
  },
  plugins: [
    nextCookies(),
    emailOTP({
      expiresIn: 300,
      otpLength: 6,
      allowedAttempts: 5,
      storeOTP: "encrypted",
      resendStrategy: "reuse",
      sendVerificationOTP: async ({ email, otp, type }) => {
        if (type !== "sign-in") return;
        if (!isAdminEmail(email) && !(await isInvitedEmail(email))) {
          console.warn("[auth] not sending login code to uninvited email", { email });
          return;
        }

        const subject = `Your Pages CMS temporary code is ${otp}`;
        const html = await render(
          LoginEmailTemplate({
            email,
            otp,
            preview: subject,
          }),
        );

        await sendEmail({
          to: email,
          subject,
          html,
        });
      },
    }),
  ],
});
