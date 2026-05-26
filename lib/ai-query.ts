import Anthropic from '@anthropic-ai/sdk'

const MODEL = 'claude-opus-4-7'

function getClient(): Anthropic {
  const apiKey = process.env.ANTHROPIC_API_KEY
  if (!apiKey) {
    throw new Error('ANTHROPIC_API_KEY is not set. Add it to .env.local and restart the dev server.')
  }
  return new Anthropic({ apiKey })
}

const SCHEMA_DESCRIPTION = `
Database schema:
- customers(id, name, email, phone, address, created_at)
- suppliers(id, name, email, phone, address, created_at)
- products(id, name, description, unit_price, sku, created_at)
- invoices(id, invoice_number, invoice_type ['sales'|'purchase'], customer_id, supplier_id,
    invoice_date, due_date, subtotal, tax_amount, total_amount,
    status ['pending'|'paid'|'overdue'|'cancelled'], currency, notes, created_at)
- invoice_line_items(id, invoice_id, product_id, description, quantity, unit_price, tax_rate, total_price, created_at)
- transactions(id, invoice_id, transaction_date, amount, transaction_type ['payment'|'refund'|'credit'], reference, notes, created_at)

Relationships:
- invoices.customer_id -> customers.id
- invoices.supplier_id -> suppliers.id
- invoice_line_items.invoice_id -> invoices.id
- invoice_line_items.product_id -> products.id
- transactions.invoice_id -> invoices.id

Notes:
- invoice_type='sales' means selling to customers; use customer_id/customers table
- invoice_type='purchase' means buying from suppliers; use supplier_id/suppliers table
- For financial year queries, Indian FY runs April to March (FY 2023-24 = Apr 2023 to Mar 2024)
- All monetary amounts are in DECIMAL(12,2)
- Use COALESCE where needed to handle NULLs
`

export async function generateSQLQuery(userQuestion: string): Promise<{ sql: string; explanation: string }> {
  const response = await getClient().messages.create({
    model: MODEL,
    max_tokens: 8096,
    thinking: { type: 'adaptive' },
    messages: [
      {
        role: 'user',
        content: `You are a PostgreSQL expert specializing in financial data analysis. Convert natural language finance questions into safe, read-only SQL queries that will be executed against a PostgreSQL database.

${SCHEMA_DESCRIPTION}

CRITICAL RULES:
1. ONLY generate SELECT queries — absolutely never INSERT, UPDATE, DELETE, DROP, TRUNCATE, ALTER, CREATE, GRANT, REVOKE, EXECUTE, or DO
2. Always use explicit column aliases for clarity (SELECT col AS alias_name)
3. Always use ROUND() for monetary values to 2 decimal places (e.g., ROUND(amount, 2))
4. For date ranges, use BETWEEN or >= / <= operators
5. Always use LIMIT 100 unless aggregating data
6. Always handle NULL values appropriately (use COALESCE)
7. For comparisons (vs, comparison, trend), use multiple CTEs or subqueries
8. For financial metrics (total, sum, average), use aggregate functions and GROUP BY appropriately
9. Never assume columns exist - only use confirmed columns from schema
10. Return ONLY a valid JSON object with exactly these two keys (no markdown, no extra text):
    {
      "sql": "SELECT ...",
      "explanation": "one-sentence description"
    }

INDIAN FINANCIAL YEAR RULES (very important):
- Indian FY runs April 1 to March 31. FY 2024-25 = Apr 1 2024 to Mar 31 2025.
- "This year" / "current year" → use the current Indian FY based on today's date (${new Date().toISOString().split('T')[0]}).
  To compute current Indian FY start: if current month >= 4, start = current_year-04-01, else start = (current_year-1)-04-01.
  Example SQL: invoice_date >= DATE_TRUNC('year', CURRENT_DATE - INTERVAL '3 months') + INTERVAL '3 months'
              AND invoice_date < DATE_TRUNC('year', CURRENT_DATE - INTERVAL '3 months') + INTERVAL '15 months'
- "Last year" → previous Indian FY (one year before current FY)
- "FY 2024-25" or "2024-25" → Apr 1 2024 to Mar 31 2025
- If NO date filter is mentioned, do NOT add one — return ALL records.
- NEVER filter by calendar year (EXTRACT(YEAR FROM invoice_date) = EXTRACT(YEAR FROM CURRENT_DATE)) for Indian finance queries.

FINANCIAL QUERY PATTERNS:
- All-time total sales: SELECT ROUND(SUM(total_amount), 2) AS total_sales FROM invoices WHERE invoice_type = 'sales'
- Sales by customer: SELECT c.name, ROUND(SUM(i.total_amount),2) AS total FROM invoices i JOIN customers c ON c.id = i.customer_id WHERE i.invoice_type='sales' GROUP BY c.name ORDER BY total DESC
- Current FY sales: WHERE invoice_type='sales' AND invoice_date >= DATE_TRUNC('year', CURRENT_DATE - INTERVAL '3 months') + INTERVAL '3 months' AND invoice_date < DATE_TRUNC('year', CURRENT_DATE - INTERVAL '3 months') + INTERVAL '15 months'
- Overdue invoices: WHERE status = 'overdue' OR (status = 'pending' AND due_date < CURRENT_DATE)
- Unpaid amounts: WHERE status IN ('pending', 'overdue')

Question: ${userQuestion}`,
      },
    ],
  })

  // Find the text block
  const textBlock = response.content.find((block) => block.type === 'text')
  if (!textBlock || textBlock.type !== 'text') {
    throw new Error('No text response from Claude')
  }

  const text = textBlock.text
  let parsed: { sql: string; explanation: string }
  try {
    // Strip markdown code fences if present
    const cleaned = text.replace(/```json\n?|\n?```/g, '').replace(/```\n?|\n?```/g, '').trim()
    parsed = JSON.parse(cleaned)
  } catch {
    throw new Error('Claude returned invalid JSON: ' + text.slice(0, 200))
  }

  if (!parsed.sql || !parsed.explanation) {
    throw new Error('Claude response missing sql or explanation fields')
  }

  // Clean trailing semicolons to prevent syntax errors in subqueries
  parsed.sql = parsed.sql.trim()
  if (parsed.sql.endsWith(';')) {
    parsed.sql = parsed.sql.slice(0, -1).trim()
  }

  // Safety check: only allow SELECT statements
  const sqlUpper = parsed.sql.toUpperCase()
  if (!sqlUpper.startsWith('SELECT') && !sqlUpper.startsWith('WITH')) {
    throw new Error('Only SELECT queries are allowed')
  }

  // Block dangerous keywords
  if (sqlUpper.match(/\b(INSERT|UPDATE|DELETE|DROP|TRUNCATE|ALTER|CREATE|GRANT|REVOKE|EXECUTE|DO)\b/)) {
    throw new Error('Dangerous SQL keywords detected')
  }

  return parsed
}

export async function generateNaturalLanguageAnswer(
  question: string,
  sql: string,
  results: unknown[]
): Promise<string> {
  if (results.length === 0) {
    return 'No data found for your query. The database may not have relevant records yet.'
  }

  const response = await getClient().messages.create({
    model: MODEL,
    max_tokens: 1024,
    messages: [
      {
        role: 'user',
        content: `You are a financial analyst assistant. Given a user's question, the SQL query used to get data, and the query results, provide a clear, concise, and accurate natural language answer.

IMPORTANT RULES:
- Be specific with all numbers, include currency symbols and proper formatting
- Keep the answer to 2-3 sentences maximum
- Do NOT make up or infer data beyond what is in the results
- If the result contains multiple rows, summarize the key insights
- For monetary values, ALWAYS use the Indian Rupee symbol ₹ (never $ or USD). Format as ₹1,00,000 using Indian number formatting (lakhs/crores)
- For percentages or rates, include the % symbol
- If results are aggregated (single row with totals), present them prominently
- This is an Indian GST finance application — all amounts are in INR (₹)

User's Question: ${question}

SQL Query Used: ${sql}

Query Results (${results.length} rows):
${JSON.stringify(results.slice(0, 20), null, 2)}

${results.length > 20 ? `Note: Results contain ${results.length} total rows. Above shows first 20.` : ''}

Provide a natural language answer based strictly on the results above. Be accurate with numbers.`,
      },
    ],
  })

  const textBlock = response.content.find((block) => block.type === 'text')
  if (!textBlock || textBlock.type !== 'text') {
    throw new Error('No text response from Claude')
  }
  return textBlock.text
}

// Financial-specific query validation
export function validateFinancialQuery(question: string): { valid: boolean; warning?: string } {
  const lowercaseQ = question.toLowerCase()

  // Detect potentially complex queries that might need clarification
  if (lowercaseQ.includes('forecast') || lowercaseQ.includes('predict')) {
    return {
      valid: true,
      warning: 'Forecast queries are based on historical data only. AI cannot predict future trends.',
    }
  }

  if (lowercaseQ.includes('anomaly') || lowercaseQ.includes('suspicious')) {
    return {
      valid: true,
      warning: 'Anomaly detection is limited to basic statistical analysis.',
    }
  }

  return { valid: true }
}

// Format financial results for display
export function formatFinancialResult(result: Record<string, unknown>): Record<string, string> {
  const formatted: Record<string, string> = {}

  for (const [key, value] of Object.entries(result)) {
    if (value === null || value === undefined) {
      formatted[key] = 'N/A'
    } else if (typeof value === 'number') {
      // Check if it's likely a monetary value
      if (
        key.toLowerCase().includes('amount') ||
        key.toLowerCase().includes('total') ||
        key.toLowerCase().includes('price') ||
        key.toLowerCase().includes('tax')
      ) {
        formatted[key] = `₹${value.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
      } else if (key.toLowerCase().includes('rate') || key.toLowerCase().includes('percent')) {
        formatted[key] = `${value.toFixed(2)}%`
      } else if (Number.isInteger(value)) {
        formatted[key] = value.toString()
      } else {
        formatted[key] = value.toFixed(2)
      }
    } else if (typeof value === 'string') {
      // Format dates
      if (/^\d{4}-\d{2}-\d{2}/.test(value)) {
        const date = new Date(value)
        formatted[key] = date.toLocaleDateString('en-US', {
          year: 'numeric',
          month: 'short',
          day: 'numeric',
        })
      } else {
        formatted[key] = value
      }
    } else {
      formatted[key] = String(value)
    }
  }

  return formatted
}
