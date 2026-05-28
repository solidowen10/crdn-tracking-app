# CRDN Frontend Handoff For Claude

Claude is the frontend and product-structure designer. Codex is the developer responsible for backend integration, deployment, and verification.

This app is deployed at:

```text
https://tool.creativeden.studio
```

Do not design or request changes for WordPress, Apache, or the root website:

```text
https://www.creativeden.studio
```

## Current App Shape

The real app is a Node/Express/SQLite internal tracker with LINE Login authentication.

Main runtime files:

```text
server.js
db.js
sheetsSync.js
public/app.html
public/login.html
package.json
```

The current frontend is a single HTML app:

```text
public/app.html
```

Claude can redesign this file or produce a replacement frontend structure, but the backend API contracts below should stay intact unless Codex updates the backend too.

## Brand Direction

- Logo URL: `https://www.creativeden.studio/wp-content/uploads/2023/09/CRDN-Square.png`
- Company color: `#ca741f`
- Preferred surface: light / white background
- UI should stay simple, tablet-friendly, and internal-tool-like.

## Auth Assumption

All app API routes require an active LINE-authenticated session.

Admin-only endpoints require:

```text
req.session.user.role === "admin"
```

Frontend should handle `401` by sending user to `/login`.

## Google Sheets Sync Feature

Google Sheets sync is now implemented as one-way export only.

Important product rule:

```text
CRDN app = source of truth
Google Sheets = reporting / backup export
```

There is no two-way sync. The Sheet should not be treated as editable source data.

### Backend Files Added Or Changed

```text
sheetsSync.js
server.js
db.js
package.json
public/app.html
.env.example
```

### Dependency

```json
"googleapis": "^144.0.0"
```

### Required Server Env Vars

```env
GOOGLE_SHEETS_SYNC_ENABLED=true
GOOGLE_SHEETS_SPREADSHEET_ID=your_sheet_id_here
GOOGLE_APPLICATION_CREDENTIALS=/var/www/crdn-tracking-app/secure/google-service-account.json
```

Never expose or print the service account private key.

### Exported Google Sheet Tabs

The sync clears old values and rewrites fresh data each time.

```text
Projects
Quote Items
Parts
Services
Activity
```

Rows are not appended blindly, so repeated syncs should not duplicate rows.

### Frontend Settings UI Needed

Settings should include a Google Sheets section with:

```text
Current Sheet ID
Sync enabled status
Credentials configured status
Test connection button
Sync now button
Last synced time
Last sync error/status
Exported tabs list
```

## Google Sheets API Contract

### GET Status

```http
GET /api/admin/google-sheets/status
```

Returns:

```json
{
  "enabled": true,
  "spreadsheet_id": "abc123",
  "credentials_configured": true,
  "tabs": ["Projects", "Quote Items", "Parts", "Services", "Activity"],
  "last_synced_at": "2026-05-26T09:33:00.000Z",
  "last_error": ""
}
```

### GET Status And Test Connection

```http
GET /api/admin/google-sheets/status?test=1
```

Success shape:

```json
{
  "enabled": true,
  "spreadsheet_id": "abc123",
  "credentials_configured": true,
  "tabs": ["Projects", "Quote Items", "Parts", "Services", "Activity"],
  "last_synced_at": "",
  "last_error": "",
  "test": {
    "ok": true,
    "spreadsheet_id": "abc123",
    "title": "CRDN Tracking Export",
    "tabs": ["Projects", "Quote Items", "Parts", "Services", "Activity"]
  }
}
```

If disabled/misconfigured, the endpoint returns an error message such as:

```json
{
  "error": "Google Sheets sync is disabled. Set GOOGLE_SHEETS_SYNC_ENABLED=true."
}
```

### POST Sync Now

```http
POST /api/admin/google-sheets/sync
```

Success shape:

```json
{
  "ok": true,
  "spreadsheet_id": "abc123",
  "title": "CRDN Tracking Export",
  "tabs": ["Projects", "Quote Items", "Parts", "Services", "Activity"],
  "counts": {
    "Projects": 4,
    "Quote Items": 18,
    "Parts": 8,
    "Services": 5,
    "Activity": 40
  },
  "synced_at": "2026-05-26T09:33:00.000Z",
  "status": {
    "enabled": true,
    "spreadsheet_id": "abc123",
    "credentials_configured": true,
    "tabs": ["Projects", "Quote Items", "Parts", "Services", "Activity"],
    "last_synced_at": "2026-05-26T09:33:00.000Z",
    "last_error": ""
  }
}
```

## Existing App API Overview

Use these routes for a redesigned frontend.

```text
GET    /auth/me
POST   /auth/logout
GET    /api/meta
GET    /api/dashboard?filter=All
POST   /api/projects
GET    /api/projects/:id
PATCH  /api/projects/:id
DELETE /api/projects/:id
DELETE /api/projects/:id/permanent
GET    /api/projects/:id/consultation
PATCH  /api/projects/:id/consultation/:itemId
GET    /api/projects/:id/quote
POST   /api/projects/:id/quote
PATCH  /api/projects/:id/quote/:quoteItemId
DELETE /api/projects/:id/quote/:quoteItemId
GET    /api/projects/:id/parts
POST   /api/projects/:id/parts
PATCH  /api/projects/:id/parts/:partId
DELETE /api/projects/:id/parts/:partId
GET    /api/projects/:id/services
PATCH  /api/projects/:id/services/:serviceId
GET    /api/projects/:id/activity
POST   /api/projects/:id/activity
GET    /api/projects/:id/customer-quote
GET    /api/admin/settings
PATCH  /api/admin/settings
POST   /api/admin/users
PATCH  /api/admin/users/:userId
POST   /api/admin/consultation/categories
PATCH  /api/admin/consultation/categories/:id
POST   /api/admin/consultation/items
PATCH  /api/admin/consultation/items/:id
POST   /api/admin/consultation/items/:id/subparts
PATCH  /api/admin/consultation/subparts/:id
DELETE /api/admin/consultation/subparts/:id
POST   /api/admin/services
PATCH  /api/admin/services/:id
GET    /api/admin/google-sheets/status
POST   /api/admin/google-sheets/sync
```

## UI Notes From Owner

- Quantity should use `+1` and `-1`, not free typing.
- Quantity minus at `1` should not remove a consultation item.
- Consultation needs a custom quote session for one-off items.
- Do not show a visible "Need Order" control in the quoting/checklist UI.
- The backend can still use internal ordering flags to activate parts after deposit.
- Invoice/customer quote should include the company logo but not extra CRDN text at the top left.
- Invoice/customer quote total should use `#ca741f`.
- Payment terms should be bilingual: English and Traditional Chinese.
- Status filters should stay simple.
- Top-left logo/brand should link back to the main dashboard.
- Parts supplier should be managed in Settings and displayed with sub-parts, not typed in the Parts tab.
- Settings sub-parts should show total cost, and adding/editing sub-parts should update the master item cost.
- Keep archive visibility and keep a permanent delete action in Admin.
- Numbers should be comma-formatted where displayed.

## Suggested Claude Output

When Claude drafts a new frontend, it should provide:

```text
1. Proposed screen map
2. Component layout
3. API calls per screen
4. States/loading/error behavior
5. Mobile/tablet behavior
6. Any backend changes requested from Codex
```

Codex can then implement, deploy, run migrations if needed, restart PM2, and verify `tool.creativeden.studio` plus `www.creativeden.studio`.
