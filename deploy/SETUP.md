# GCP Setup Guide — 5 manual steps

## Step 1 — Enable Sheets API
1. Go to https://console.cloud.google.com
2. Select your project (reuse the saf.ai GCP project if convenient)
3. APIs & Services → Enable APIs → search "Google Sheets API" → Enable

## Step 2 — Create a Service Account
1. IAM & Admin → Service Accounts → Create Service Account
2. Name: `mem-manager`
3. Description: "Claude memory backing store sync"
4. Role: not required (access is via Sheet sharing, not GCP IAM)
5. Create → Done (skip optional steps)

## Step 3 — Download the Key
1. Click the service account → Keys tab → Add Key → JSON
2. Save the downloaded file to:
   - Mac (now):   /Users/ahmed/projects/mem-manager/credentials/service-account.json
   - gamgee:      /home/ahmed/mem-manager/credentials/service-account.json
3. Note the service account email (looks like mem-manager@PROJECT.iam.gserviceaccount.com)

## Step 4 — Create the Google Sheet
1. Go to https://sheets.google.com → New spreadsheet
2. Name it: "ahmed-mem-manager"
3. Copy the Sheet ID from the URL:
   https://docs.google.com/spreadsheets/d/SHEET_ID_IS_HERE/edit
4. Paste it into .env as GOOGLE_SHEET_ID

## Step 5 — Share the Sheet with the Service Account
1. In the Sheet → Share button
2. Paste the service account email from Step 3
3. Role: Editor
4. Uncheck "Notify people" → Share

## Step 6 — Copy .env.example → .env and fill in values
```bash
cp .env.example .env
# edit .env: set GOOGLE_SHEET_ID and confirm GOOGLE_SERVICE_ACCOUNT_KEY path
```

## Step 7 — Install dependencies and run setup
```bash
cd /Users/ahmed/projects/mem-manager
npm install
npm run setup      # seeds the sheet from local master.csv
npm run status     # verify
```

## For gamgee (when ready)
```bash
# Copy project to gamgee
rsync -av /Users/ahmed/projects/mem-manager/ ahmed@gamgee:/home/ahmed/mem-manager/

# On gamgee:
cd /home/ahmed/mem-manager
npm install
cp .env.example .env   # fill in paths for gamgee
sudo cp deploy/mem-manager.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable mem-manager
sudo systemctl start mem-manager
journalctl -u mem-manager -f   # watch logs
```
