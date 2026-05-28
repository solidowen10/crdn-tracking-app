# Google Sheets Sync

This document describes the implemented one-way Google Sheets export for the CRDN tracking app.

## Rule

The CRDN app is the source of truth. Google Sheets is export/reporting backup only.

There is no two-way sync.

## Runtime Requirements

Set these environment variables on the server:

```env
GOOGLE_SHEETS_SYNC_ENABLED=true
GOOGLE_SHEETS_SPREADSHEET_ID=your_sheet_id_here
GOOGLE_APPLICATION_CREDENTIALS=/var/www/crdn-tracking-app/secure/google-service-account.json
```

The service account JSON file must stay on the server and must not be committed or printed.

The target Google Sheet must be shared with the service account email as Editor.

## Files

```text
sheetsSync.js
server.js
db.js
public/app.html
package.json
```

## Dependency

```json
"googleapis": "^144.0.0"
```

## Auth

The sync uses Google service account auth through:

```text
GOOGLE_APPLICATION_CREDENTIALS
```

Scope:

```text
https://www.googleapis.com/auth/spreadsheets
```

## Admin API

```http
GET /api/admin/google-sheets/status
GET /api/admin/google-sheets/status?test=1
POST /api/admin/google-sheets/sync
```

All routes require an authenticated admin session.

## Export Behavior

For every sync:

1. Verify sync is enabled.
2. Verify spreadsheet ID exists.
3. Verify credentials path is configured.
4. Connect with Google Sheets API.
5. Ensure these tabs exist:

```text
Projects
Quote Items
Parts
Services
Activity
```

6. Clear old values from each tab.
7. Write header row and fresh rows from SQLite.

This avoids duplicate rows.

## Exported Tabs

### Projects

Source table: `vehicles`

Columns:

```text
Project ID
Job #
Customer
Vehicle
Plate / ID
Package
Stage
Progress %
Priority
Designer
Start Date
Est. Finish
Customer Update
Customer Action
Next Action
Notes
Archived
Created At
Updated At
```

### Quote Items

Source table: `quote_items`, joined to `vehicles`

Columns:

```text
Quote Item ID
Project ID
Job #
Customer
Vehicle
Category
Description
Quantity
Customer Unit Price
Customer Subtotal
Internal Unit Cost
Internal Subtotal
Profit
Supplier
Parts Status
Internal Notes
Active
Created At
Updated At
```

### Parts

Source table: `parts`, joined to `vehicles` and `quote_items`

Columns:

```text
Part ID
Project ID
Job #
Customer
Vehicle
Quote Item ID
Linked Quote Item
Part / Item
Supplier
Quantity
Cost
Status
ETA
Arrived Date
Installed Date
Notes
Created At
Updated At
Sub-parts
Sub-parts Cost Total
```

### Services

Source table: `project_services`, joined to `vehicles`

Columns:

```text
Project Service ID
Project ID
Job #
Customer
Vehicle
Service
Description
Active
Created At
Updated At
```

### Activity

Source table: `activity_log`, left joined to `vehicles`

Columns:

```text
Activity ID
Project ID
Job #
Customer
Vehicle
User
LINE User ID
Action
Old Value
New Value
Created At
```

## UI

Settings -> Google Sheets currently shows:

```text
Current Sheet ID
Sync enabled status
Credentials configured status
Last synced time
Last sync error/status
Export tabs
Test Connection button
Sync Now button
```

## Deployment Notes

After changing env vars on the server:

```bash
cd /var/www/crdn-tracking-app
pm2 restart crdn-tracking-app --update-env
pm2 save
```

Then log in as admin and use:

```text
Settings -> Google Sheets -> Test Connection
Settings -> Google Sheets -> Sync Now
```
