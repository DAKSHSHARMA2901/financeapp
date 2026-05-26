# FinanceApp — Bulk Invoice Processing & AI-Powered Financial Querying

A Next.js 14 application for bulk invoice upload and natural-language financial queries, built on Supabase and Claude AI.

**🚀 [Live Demo](https://finance-app-steel-rho.vercel.app/)**

---

## Architecture

```
┌─────────────────────────────────────────────────────┐
│  Next.js 14 (App Router)                            │
│  ┌──────────┐  ┌──────────┐  ┌───────────────────┐ │
│  │ /upload  │  │/dashboard│  │    /ai-query       │ │
│  └────┬─────┘  └────┬─────┘  └────────┬──────────┘ │
│       │              │                 │             │
│  ┌────▼─────────────────────────────────────────┐   │
│  │  API Routes                                  │   │
│  │  POST /api/upload   POST /api/ai-query       │   │
│  └────┬────────────────────────┬───────────────┘   │
└───────┼────────────────────────┼───────────────────┘
        │                        │
   ┌────▼───────┐          ┌─────▼──────┐
   │  Supabase  │          │ Claude API │
   │ PostgreSQL │          │ (Anthropic)│
   │    Auth    │          │ Text→SQL   │
   │ Edge Func  │          └────────────┘
   └────────────┘
```

### Data Flow

**Upload:**  
File (CSV/XLSX) → `/api/upload` → `invoice-normalizer.ts` (column mapping + validation) → Supabase PostgreSQL (upsert with dedup)

**AI Query:**  
User question → `/api/ai-query` → Claude (generate SQL) → Supabase `run_safe_query` RPC → Claude (summarize results) → Chat UI

---

## Tech Stack

| Layer | Technology |
|-------|------------|
| Frontend | Next.js 14, TypeScript, Tailwind CSS |
| Backend | Next.js API Routes |
| Database | Supabase PostgreSQL |
| Auth | Supabase Auth |
| Edge Function | Supabase Edge Functions (Deno) |
| AI | Anthropic Claude (claude-opus-4-7) |
| File Parsing | xlsx, papaparse |

---

## Setup

### 1. Clone and install

```bash
git clone <your-repo>
cd finance-app
npm install
```

### 2. Create a Supabase project

1. Go to [supabase.com](https://supabase.com) and create a new project
2. In the SQL editor, run both migration files in order:
   - `supabase/migrations/001_initial_schema.sql`
   - `supabase/migrations/002_rpc_and_sample.sql`

### 3. Environment variables

Copy `.env.example` to `.env.local` and fill in your values:

```bash
cp .env.example .env.local
```

```env
NEXT_PUBLIC_SUPABASE_URL=https://xxxx.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=eyJ...
SUPABASE_SERVICE_ROLE_KEY=eyJ...
ANTHROPIC_API_KEY=sk-ant-...
```

- Supabase URL and keys: **Project Settings → API**
- Anthropic API key: [console.anthropic.com](https://console.anthropic.com)

### 4. Deploy Supabase Edge Function (optional)

```bash
npm install -g supabase
supabase login
supabase link --project-ref <your-project-ref>
supabase functions deploy process-invoices
```

### 5. Run locally

```bash
npm run dev
```

Open [http://localhost:3000](http://localhost:3000)

---

## Features

### Bulk Upload (`/upload`)
- Drag-and-drop CSV or Excel files
- Flexible column name mapping (20+ aliases per field)
- Automatic data normalization:
  - Date format detection (ISO, DD/MM/YYYY, DD-MM-YYYY, Excel serial)
  - Currency symbol stripping
  - Invoice type inference (sales vs purchase)
  - Status normalization
- Duplicate prevention via `UNIQUE(invoice_number, invoice_type)`
- Detailed error reporting per row
- Audit trail via `upload_logs` table

### Dashboard (`/dashboard`)
- Total invoice count
- Total paid sales and purchases
- Overdue invoice summary
- Net position and profit margin
- Recent invoices table with status badges

### AI Query (`/ai-query`)
- Natural language → SQL via Claude
- Query runs against live Supabase data
- Natural language answer synthesized from results
- Expandable SQL view for transparency
- Results table for raw data
- Example prompts included

---

## Database Schema

```
customers     → invoices (customer_id)
suppliers     → invoices (supplier_id)
invoices      → invoice_line_items (invoice_id)
products      → invoice_line_items (product_id)
invoices      → transactions (invoice_id)
auth.users    → upload_logs (user_id)
```

All tables have `created_at`/`updated_at` with auto-update triggers, proper indexes, and Row Level Security (authenticated users only).

---

## Sample Invoice CSV Format

```csv
invoice_number,date,customer,total,tax,status
INV-001,2024-01-15,Acme Corp,1180.00,180.00,paid
INV-002,2024-01-20,TechStart Ltd,2360.00,360.00,pending
```

The normalizer also accepts: `invoice_no`, `bill_date`, `client`, `grand_total`, `gst`, `vat`, etc.
