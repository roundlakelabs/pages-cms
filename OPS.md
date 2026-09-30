# Pages CMS: Self-hosted on DigitalOcean

Reference for running, updating, and rebuilding our Pages CMS instance.

- Official docs: https://pagescms.org/docs
- Upstream repo: https://github.com/pages-cms/pages-cms
- **Our fork (deployed):** https://github.com/roundlakelabs/pages-cms

> Replace the placeholders `cms.roundlakelabs.com`, `roundlakelabs`, and `"Round Lake Labs CMS"` throughout.
> Never commit secrets. `.env` lives only on the droplet and in the password manager.

---

## At a glance

| Thing | Value |
| --- | --- |
| URL | `https://cms.roundlakelabs.com` |
| Server | DigitalOcean droplet (NYC1, 1 vCPU / 1 GB + 2 GB swap), Ubuntu 24.04 |
| SSH | `ssh deploy@cms.roundlakelabs.com` (`deploy` has sudo) |
| App directory | `/opt/pages-cms`, a clone of **our fork** (`origin` = `roundlakelabs/pages-cms`) |
| Config | `/opt/pages-cms/.env` |
| Service | `pages-cms` (systemd), runs `next start` on `127.0.0.1:3000` |
| Reverse proxy | nginx: `/etc/nginx/sites-available/pages-cms` |
| TLS | Let's Encrypt via Certbot (auto-renews) |
| Database | PostgreSQL on the droplet, db `pagescms`, user `pagescms` |
| GitHub App | Owned by org `roundlakelabs`: `github.com/organizations/roundlakelabs/settings/apps` |
| Email | Resend (or SMTP), used for login codes and invites |

The request path is browser → nginx (443) → Next.js app (127.0.0.1:3000) → Postgres (localhost:5432), with the GitHub API and webhooks going in both directions.

---

## Who can log in (our custom access model)

Upstream Pages CMS lets anyone sign up. **Our fork changes that** (see "Our changes to upstream" below):

| Who | How they log in | What they can access |
| --- | --- | --- |
| **Admins** (emails in `ADMIN_EMAILS`) | GitHub or email code | Repos the GitHub App is installed on **and** they can push to on GitHub, plus the admin panel |
| **Editors** (invited collaborators) | Email code only | Only the repos they were invited to |
| Anyone else | Refused | Nothing. Uninvited emails never receive a code. |

- **Add an editor:** in the CMS, open the repo → collaborators → invite their email. That's all.
- **Remove an editor:** remove them as a collaborator from every repo. Their next login is refused.
- **Kick everyone out now:** `sudo -u postgres psql pagescms -c 'TRUNCATE session;'` (everyone must log in again).
- **Limit which repos the CMS can touch at all:** `github.com/organizations/roundlakelabs/settings/installations` → the app → Configure → *Only select repositories*.
- A non-admin who clicks the GitHub button gets an error. That's expected.
- The email checked for GitHub admins is the account's **public profile email** if one is set, otherwise the primary email. `ADMIN_EMAILS` must match that one.

---

## Everyday commands

```bash
# Service
sudo systemctl status pages-cms
sudo systemctl restart pages-cms         # needed after any .env change

# Logs
journalctl -u pages-cms -f               # live (Ctrl+C to stop)
journalctl -u pages-cms -n 100           # last 100 lines
journalctl -u pages-cms --since "1 hour ago"
journalctl -u pages-cms -f | grep "\[auth\]"   # login blocks only
sudo tail -f /var/log/nginx/error.log    # 502s and proxy errors
sudo tail -f /var/log/nginx/access.log   # all requests

# nginx / TLS
sudo nginx -t && sudo systemctl reload nginx
sudo certbot certificates
sudo certbot renew --dry-run
```

**Debugging tip:** run `journalctl -u pages-cms -f` and `sudo tail -f /var/log/nginx/error.log` in two SSH windows, then reproduce the problem in the browser.

---

## Updating Pages CMS

Changes flow from upstream to our fork (rebased on the Mac) and then to the droplet.

**1. On the Mac** (in the local clone of the fork; `upstream` = `pages-cms/pages-cms`):

```bash
git fetch upstream
git rebase upstream/main
# On conflict (usually lib/auth.ts): fix it, `git add`, then `git rebase --continue`
git push --force-with-lease
```

First time on a new machine:

```bash
git clone https://github.com/roundlakelabs/pages-cms.git && cd pages-cms
git remote add upstream https://github.com/pages-cms/pages-cms.git
```

**2. On the droplet:**

```bash
sudo -u postgres pg_dump pagescms | gzip > ~/backups/pre-update-$(date +%F).sql.gz
cd /opt/pages-cms
git fetch origin && git reset --hard origin/main   # .env is untracked, so it's safe
npm install
npm run build                                      # postbuild hook also runs DB migrations
sudo systemctl restart pages-cms
```

**3. Verify the lock still works:** log in as admin (should work), then try a non-admin GitHub account (should be refused, with `[auth] blocked` in the logs).

Before a major version bump, read the upgrade notes at https://pagescms.org/docs.

---

## Our changes to upstream

All custom changes are commits on top of upstream in our fork. Keep them small so rebases stay easy.

### 1. Login restriction (`lib/auth.ts`), **security-critical**

- The GitHub OAuth callback (`/callback/:id`) creates users and sessions only for `ADMIN_EMAILS`.
- Email-code login and sign-up are allowed only for admins or emails in the `collaborator` or `collaborator_invite` tables.
- `sendVerificationOTP` silently skips uninvited emails.
- Implemented with better-auth `databaseHooks.user.create.before` and `databaseHooks.session.create.before`, using `ctx.path` to tell GitHub logins from email logins.

If a rebase conflicts here, **resolve it. Don't drop the commit.** Deploying without it reopens public sign-ups.

If upstream ever adds a built-in way to restrict logins, switch to that and drop this commit.

### 2. GitHub App helper fixes (`scripts/setup-github-app.mjs`), only if committed

The helper in v2.1.8 generates a manifest that GitHub rejects:

- `"secret" is not a permitted key` → remove `secret: webhookSecret,` from `hook_attributes`.
- `Default permission records resource is not included in the list` → rename `email_addresses: "read"` to `emails: "read"`.

This is only needed if we ever recreate the GitHub App. Check whether upstream has fixed it first.

### 3. Grid layout for list fields (`list.grid`)

Shows a list field as a grid of image tiles instead of stacked rows, so editors see a photo gallery the way the site lays it out. It only changes the editor. **The stored data doesn't change:** the list is still one array in one file, in the same order.

**When to use it:** a list of photos in a single content file, e.g. hhcookies' `src/_data/gallery.json` (`{ "photos": [ { "image": "...", "alt": "" }, ... ] }`).

**Config** (in the site repo's `.pages.yml`):

```yaml
- name: photos
  label: Photos
  type: object
  list:
    grid:
      columns: 3      # tiles per row, 1–12 (default 4)
      image: image    # subfield shown on the tile (default: first image subfield)
      aspect: 1       # tile shape: "4/3", "4:3" or a number (default square)
  fields:
    - { name: image, type: image, required: true, options: { media: gallery } }
    - { name: alt, type: string }
```

It also works on a plain image list, where each item is just a path string and is used as the tile directly:

```yaml
- name: photos
  type: image
  options: { media: gallery }
  list:
    grid: { columns: 4, aspect: "4/3" }
```

`grid` only works on `object` and `image` fields. Using it on any other type fails config validation. `min` and `max` still apply alongside `grid`. `collapsible` is ignored in grid mode.

**What editors can do:**

| Action | How |
| --- | --- |
| Reorder | Drag a tile, or use the grip button that appears on hover (keyboard-accessible). Saved order = grid order. |
| Edit an item | Click a tile. Its fields (e.g. alt text) open in a dialog. |
| Remove | Hover a tile → trash icon → confirm. Hidden when readonly or at `min`. |
| Add photos | **Upload** (or drop files on the grid) or **Select** from the media library. This adds one item per image, with the image subfield filled in. |
| Add an empty item | **Add an item** creates the item and opens it for editing. |

The add buttons disappear once `max` is reached. An item that fails validation (e.g. a description but no photo) gets a red outline, and its dialog shows the error. A tile with no image shows a placeholder.

**Code:** `components/entry/entry-form.tsx` (`ListGrid`, `GridTile`, and the grid branch in `ListField`), `lib/config-schema.ts` (`ListGridSchema`), `lib/utils/aspect-ratio.ts`, `types/field.ts`, and a `style` prop on `components/thumbnail.tsx`. Lists without `grid` are unaffected.

The same commit also fixes an upstream validation bug: `list: { min: 1 }` without `collapsible` used to fail. `collapsible` is now optional.

**Known limitation (upstream behavior, not specific to the grid):** an added item left completely blank saves as `{ "image": null }` without a required-field error. Validation only runs once some field in the item has a value.

---

## Environment variables (`/opt/pages-cms/.env`)

| Variable | Notes |
| --- | --- |
| `DATABASE_URL` | `postgresql://pagescms:<password>@localhost:5432/pagescms` |
| `BETTER_AUTH_SECRET` | Random secret (`openssl rand -base64 32`). Changing it logs everyone out. |
| `CRYPTO_KEY` | Encrypts GitHub tokens in the DB. **Don't change it**, or stored tokens become unreadable. |
| `BASE_URL` | `https://cms.roundlakelabs.com`. Must exactly match the GitHub App URLs. |
| `ADMIN_EMAILS` | Comma-separated. Controls admin panel access **and** who may log in with GitHub (our patch). |
| `GITHUB_APP_ID` | From the GitHub App page. |
| `GITHUB_APP_NAME` | App slug (from the app's GitHub URL). |
| `GITHUB_APP_CLIENT_ID` | From the GitHub App page. |
| `GITHUB_APP_CLIENT_SECRET` | Generated on the GitHub App page. |
| `GITHUB_APP_PRIVATE_KEY` | PEM, as one quoted line with `\n` escapes. |
| `GITHUB_APP_WEBHOOK_SECRET` | Must match the Webhook secret field in the GitHub App settings. |
| `EMAIL_PROVIDER` | `resend` or `smtp`. **Required** for editors to log in. |
| `EMAIL_FROM` | Sender address, e.g. `cms@mydomain.com` |
| `RESEND_API_KEY` | If using Resend. |
| `SMTP_HOST` / `SMTP_PORT` / `SMTP_USER` / `SMTP_PASSWORD` | If using SMTP. |

The full list is at https://pagescms.org/docs/development/environment-variables/

Keep a copy of `.env` in the password manager. **After editing it, run `sudo systemctl restart pages-cms`.**

---

## Backups

Site content lives in GitHub. The database holds users, sessions, **collaborator invites** (who can log in), and cache, so losing it means re-inviting every editor.

```bash
mkdir -p ~/backups

# Manual backup
sudo -u postgres pg_dump pagescms | gzip > ~/backups/pagescms-$(date +%F).sql.gz

# Restore into an empty database
gunzip -c ~/backups/pagescms-YYYY-MM-DD.sql.gz | sudo -u postgres psql pagescms
```

For nightly backups, add this with `crontab -e` as `deploy` (the `\%` escapes are required inside crontab):

```
0 3 * * * sudo -u postgres pg_dump pagescms | gzip > /home/deploy/backups/pagescms-$(date +\%F).sql.gz
```

Prune old backups occasionally. Enabling DigitalOcean droplet backups on top of this is cheap insurance.

---

## GitHub App settings

Location: `github.com/organizations/roundlakelabs/settings/apps` → the app.

| Setting | Value |
| --- | --- |
| Homepage URL | `https://cms.roundlakelabs.com` |
| Callback URL | `https://cms.roundlakelabs.com/api/auth/callback/github` |
| Setup URL | `https://cms.roundlakelabs.com/` (redirect on update: on) |
| Webhook URL | `https://cms.roundlakelabs.com/api/webhook/github` |
| Webhook secret | Same as `GITHUB_APP_WEBHOOK_SECRET` |
| User-to-server token expiration | **Off**. Otherwise users get logged out periodically. |
| Installed on | Only the site repos (*Only select repositories*) |

Permissions: Email addresses (read); Administration, Actions, and Contents (read & write); Checks, Commit statuses, and Metadata (read).
Events: Installation target, Repository, Push, Delete, Check run, Check suite, Status, Workflow run.

Each repo edited in the CMS needs a `.pages.yml` at its root: https://pagescms.org/docs/configuration/

---

## Changing the domain

1. Point DNS for the new domain at the droplet.
2. Update every URL in the GitHub App settings (table above).
3. Update `BASE_URL` in `.env`.
4. Update `server_name` in `/etc/nginx/sites-available/pages-cms`, then run `sudo certbot --nginx -d new.domain.com`.
5. Rebuild and restart: `cd /opt/pages-cms && npm run build && sudo systemctl restart pages-cms`.

---

## Rebuilding from scratch

### 1. Droplet

- Ubuntu 24.04. With 1 GB of RAM, swap is required or `npm run build` gets killed.
- Point an A record for `cms.roundlakelabs.com` at the droplet IP.

```bash
# as root
adduser deploy && usermod -aG sudo deploy
rsync --archive --chown=deploy:deploy ~/.ssh /home/deploy
ufw allow OpenSSH && ufw allow 'Nginx Full' && ufw enable

fallocate -l 2G /swapfile && chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile
echo '/swapfile none swap sw 0 0' >> /etc/fstab
```

### 2. Packages and database (as `deploy`)

```bash
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs git postgresql nginx certbot python3-certbot-nginx

sudo -u postgres psql -c "CREATE USER pagescms WITH PASSWORD '<password>';"
sudo -u postgres psql -c "CREATE DATABASE pagescms OWNER pagescms;"
```

To restore data, load the latest backup now (see Backups).

### 3. App (our fork)

```bash
sudo mkdir -p /opt/pages-cms && sudo chown deploy:deploy /opt/pages-cms
git clone https://github.com/roundlakelabs/pages-cms.git /opt/pages-cms
cd /opt/pages-cms
```

If the fork is private, add a read-only deploy key to the repo first.

Restore `.env` from the password manager. For a brand-new install, create it with at least `DATABASE_URL`, `BETTER_AUTH_SECRET`, `CRYPTO_KEY`, `BASE_URL`, `ADMIN_EMAILS`, the email provider variables, and the `GITHUB_APP_*` variables (next step).

### 4. GitHub App (only if the existing one is gone)

Run the helper **on the Mac, not the droplet**. It finishes by redirecting the browser to `http://localhost:8787`, so the script and the browser must be on the same machine.

```bash
git clone https://github.com/roundlakelabs/pages-cms.git && cd pages-cms && npm install

# If the helper fixes aren't committed in the fork and upstream hasn't fixed them (macOS sed):
sed -i '' '/secret: webhookSecret,/d' scripts/setup-github-app.mjs
sed -i '' 's/email_addresses: "read"/emails: "read"/' scripts/setup-github-app.mjs

npm run setup:github-app -- \
  --base-url https://cms.roundlakelabs.com \
  --env .env.github \
  --owner-type org \
  --org roundlakelabs \
  --app-name "Round Lake Labs CMS"      # must be unique across all of GitHub
```

This requires being an org owner or having the GitHub App manager role. Then:

1. Copy `GITHUB_APP_WEBHOOK_SECRET` from `.env.github` into the app's **Webhook secret** field on GitHub. The patched helper can't set it.
2. Turn off **User-to-server token expiration**.
3. Install the app on the org with *Only select repositories*.
4. Copy the credentials to the droplet and delete the local copies:

```bash
grep '^GITHUB_APP_' .env.github > github-app.env
scp github-app.env deploy@cms.roundlakelabs.com:/opt/pages-cms/
ssh deploy@cms.roundlakelabs.com "cd /opt/pages-cms && cat github-app.env >> .env && rm github-app.env"
rm .env.github github-app.env
```

### 5. Build

```bash
cd /opt/pages-cms
grep -o '^[A-Z_]*=' .env      # every variable present, none duplicated
npm install
npm run build                 # also runs migrations via postbuild
```

### 6. systemd service

`/etc/systemd/system/pages-cms.service`:

```ini
[Unit]
Description=Pages CMS
After=network.target postgresql.service

[Service]
User=deploy
WorkingDirectory=/opt/pages-cms
Environment=NODE_ENV=production
Environment=PORT=3000
Environment=HOSTNAME=127.0.0.1
ExecStart=/usr/bin/npm run start
Restart=always

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now pages-cms
curl -I http://127.0.0.1:3000
```

### 7. nginx + HTTPS

`/etc/nginx/sites-available/pages-cms`:

```nginx
server {
    listen 80;
    server_name cms.roundlakelabs.com;

    client_max_body_size 25m;   # nginx default is 1 MB, which blocks media uploads

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
    }
}
```

```bash
sudo ln -s /etc/nginx/sites-available/pages-cms /etc/nginx/sites-enabled/
sudo rm -f /etc/nginx/sites-enabled/default
sudo nginx -t && sudo systemctl reload nginx
sudo certbot --nginx -d cms.roundlakelabs.com
```

### 8. Verify

Admin GitHub login works, a non-admin GitHub login is refused, an invited email gets a code, and an uninvited email doesn't.

---

## Troubleshooting

| Symptom | Likely cause / fix |
| --- | --- |
| `npm run build` killed with no clear error | Out of memory. Check swap with `free -h`. |
| DB error at the end of `npm run build` | Wrong `DATABASE_URL`, or Postgres is down (`sudo systemctl status postgresql`). |
| 502 Bad Gateway | App not running. Check `journalctl -u pages-cms -n 100`. |
| Log shows `[auth] blocked sign-up` / `blocked login` | Working as intended for strangers. If it's an admin, the email shown doesn't match `ADMIN_EMAILS` (usually the GitHub public profile email vs primary). Fix `.env` and restart. |
| `TypeError: Cannot read properties of null (reading 'id')` + `unable_to_create_user` | Harmless side effect of a blocked sign-up (see the row above). |
| Editor never receives a login code | Not invited to any repo, or email provider misconfigured. Look for `not sending login code` or mailer errors in the logs. |
| GitHub login redirect mismatch | `BASE_URL` doesn't exactly match the GitHub App callback URL (https, no trailing slash). |
| Logged in but bounced back to login | `BASE_URL` differs from the URL being visited. |
| Users logged out every ~8 hours | Token expiration is still on in the GitHub App settings. |
| Content doesn't refresh after a push | Webhook failing. Check Advanced → Recent Deliveries on the GitHub App; usually a secret mismatch. |
| Image upload fails | `client_max_body_size` in nginx is too small. |
| Repo not visible in the CMS | App not installed on it, the user lacks access or wasn't invited to it, or there's no `.pages.yml`. |
| `.env` change has no effect | Restart the service. The app only reads `.env` at startup. |

