# Daksha Nirmaan Traders — Prototype Walkthrough

This is a guide to the clickable prototype at `prototype/daksh-nirmaan.html`. It uses demo data — nothing you click actually saves. Toasts (small pop-ups at the bottom) tell you what the real app *would* have written to the books at that moment.

Two words worth knowing up front:
- **Post** = commit to the books. A number is assigned, a journal entry (double-entry accounting record) and a stock movement are written together, and it cannot be edited afterwards.
- **Cancel** = a reversal entry. The original number stays (GST rules require every number to be accounted for, even cancelled ones); a mirror entry undoes its effect.

---

## 1. A day at the counter

**Morning — open the shop.** Kishore opens the app; **Dashboard** loads. He sees today's sales (₹0 so far), what's to collect (₹4,91,750), what's to pay, cash + bank on hand, and stock value. The "Needs attention" list flags an overdue customer, a low-stock item, a cheque due Monday, and open challans.

**A builder walks in for TMT + cement.** Kishore taps **+ New invoice** (Sales screen). He picks the customer (Sri Venkateswara Constructions), the site (Poranki), adds a line of Tata Tiscon 12mm TMT — types **47 pcs**, the app converts that to kg using the item's per-piece weight (1 pc = 10.66 kg) since stock is always tracked in kg — and adds a cement line. He taps **Post invoice**. *Behind the scenes: one transaction writes the customer's ledger up (they owe more), sales + GST output up, cost of goods sold up, and stock down at the item's weighted-average cost — plus a GST invoice number and an audit row.*

**Goods for a site, invoice later.** For a builder who wants material now but will be billed at month-end, Kishore uses **Delivery challan** instead. He taps **Post challan**. *Behind the scenes: stock leaves as "in transit to customer" — no revenue booked yet.* The invoice gets raised later against this challan.

**A customer pays by UPI.** On **Payments → Receive payment**, Kishore picks the customer, enters the amount, mode UPI, and allocates it against their open invoices (oldest first, or manually) — this drives the ageing report. He taps **Post receipt**. *Behind the scenes: bank goes up, the customer's ledger goes down by the allocated amount.*

**The driver needs cash for fuel.** On **Staff → Pay advance**, Kishore picks the driver, enters ₹500, mode Cash, and posts. Counter staff can post advances up to ₹5,000 without an admin. *Behind the scenes: an Employee Advances ledger entry against that person, cash down — recovered automatically at next salary.*

**Checking stock.** On **Stock**, Kishore sees Tiscon 12mm is fine but ACC Gold cement is low (145 bags, reorder at 200). Tapping an item opens its **item ledger** — every in/out movement with running balance and average cost, each linking back to the invoice, bill, challan, or transfer that caused it.

**Closing the day.** On **Reports → Day close**, the app shows opening cash + cash sales + cash receipts − advances/wages − expenses − bank deposits = expected drawer cash. Kishore counts the actual drawer and types it in; if it doesn't match, the difference posts to a "Cash Over/Short" account — never silently absorbed. He taps **Close the day**.

---

## 2. Screen-by-screen reference

**Dashboard** — today's numbers (sales, to collect, to pay, cash+bank, stock value, low-stock count), a 7-day sales chart (cement vs steel), and a "needs attention" list (overdue accounts, low stock, cheques due, un-invoiced challans, filing status). Quick-action buttons jump straight to New invoice, Receive payment, Challan, Day close. Everyone sees this.

**Sales** — list of invoices, challans, and credit notes, filterable by type, searchable by party/number.
| Button | Does |
|---|---|
| + New invoice | Draft a GST sale, add lines, post |
| + Challan | Goods-out-now document, no revenue |
| Post invoice / Save draft | Commit permanently / keep editable |
| Cancel (reversal) | Reverses a posted invoice, keeps its number |
| PDF / WhatsApp / Print | Placeholders in the prototype |

Anyone (admin or counter user) can draft and post sales invoices and receipts; only admins can cancel.

**Purchases** — supplier bills, debit notes, and RCM (reverse-charge) freight from lorry owners. Shows payable, this month's ITC (input tax credit), RCM payable, and rebates accrued. New bill: enter supplier, their bill number, line items with rate — stock comes in at that rate and a new weighted-average cost is recalculated per item. The freight toggle posts a separate reverse-charge entry when the lorry owner isn't GST-registered. **Admin only.**

**Payments** — receipts, supplier payments, and cheque tracking. Tiles show received today, cheques in hand (PDC = post-dated cheque, not yet due), cheques issued, and unallocated ("on account") amounts. **Receive payment**: pick the customer, amount, mode; if Cheque, extra fields for cheque number/date/bank appear — it sits in "cheques in hand" until deposited and cleared; a bounce reverses the entry and re-opens the invoices it settled. The allocation grid lets you split one payment across several open invoices, or auto-allocate oldest-first. **Bank reconciliation**: matches bank-statement lines against posted vouchers; unmatched lines (bank charges, an unexpected UPI credit) get a button to create the missing voucher.

**Parties** — one list of customers and suppliers with balance, ageing bucket, credit-limit usage bar, and status chip. Tap a row to open a **ledger**: full transaction history with running balance, ageing tiles (0–30/31–60/61–90/90+ days), and — for customers with delivery sites — chips for each site. + New party creates a customer or supplier record with credit limit/days/interest rate.

**Stock** — item list with quantity on hand, weighted-average cost, value, and a stock-level chip (OK/Low). Godown filter (Head Godown / Gannavaram / All) — Gannavaram is a second demo godown, not a real second location yet. Tap an item for its **item ledger** (every movement, in/out, rate, running balance and average cost). Adjustment (admin only, for loss/damage or count corrections) and Godown transfer (moves stock between locations as "in transit" with no journal entry — value stays in Inventory) are separate modals.

**Staff** — salary, wages, and advances per person. Tiles: monthly salary bill, advances outstanding, amount paid last month, vehicle running costs. + Pay advance (any role, ≤₹5,000 for counter users), + Record salary (nets off outstanding advances automatically), + Daily wages (for day-rate workers like godown loaders). Tap a name for their personal ledger. Salaries post as plain expense vouchers — no GST involved.

**Reports** — a grid of report cards, each tagged with the build phase it belongs to (Phase 1/2/3). Working in the prototype: Day close, Trial balance (assets = liabilities + equity, enforced by a database trigger — if it doesn't balance, that's a bug), Receivables ageing, GSTR-1 (B2B/B2C split + HSN summary, ready for portal JSON/Excel export). Others (P&L, balance sheet, GSTR-3B, rebate tracker, site-wise sales, e-way bill/e-invoice API) show a "not in this prototype" toast. **Trial balance and GSTR-1 are admin only.**

**Settings** — admin only, tabbed: Organisation (legal name, GSTIN, address, bank/UPI details, e-invoicing and negative-stock toggles), Users & roles (admins = owners + Ratna; one counter user, Kishore, with his exact permissions spelled out; invites are the only way in — no public sign-up, max 10 users), Items (master list with HSN, GST rate, UOM, TMT piece-weight, reorder level — changes here only affect future invoices, since tax/HSN are snapshotted onto historical documents), Chart of accounts (the underlying ledger structure), Period locks (a locked month rejects any posting dated inside it, including cancellations; unlocking is logged), Backups & data (Supabase daily backups, weekly encrypted dump, restore-drill record, and a documented fallback procedure for when the app is down), Audit trail (who did what, when — every post, cancel, and unlock).

**Login** — email + one-time code, admins also confirm via an authenticator app (TOTP). No public sign-up.

---

## 3. Month-end and owner tasks

**Recording a purchase with RCM freight.** Owners enter the supplier bill (Purchases → + New bill), add line items at cost, and if a lorry owner (unregistered, GTA — goods transport agency) charged freight, tick the RCM toggle: this posts freight as an expense to the lorry owner and separately books RCM payable + claimable input GST, since GST on unregistered transport is paid by the buyer, not the seller.

**Cheque lifecycle.** A cheque received sits as **PDC (post-dated cheque) in hand** until its date arrives — it isn't cash yet. Deposit it and mark it cleared once the bank confirms. If it bounces, the app reverses the receipt automatically and the invoices it had settled reopen as unpaid.

**Bank reconciliation.** Import the statement, match each line to a posted voucher automatically where possible; for the leftovers (bank charges, a stray UPI credit) the app offers a button to create the missing expense or receipt so book balance and bank balance converge.

**Period lock after GSTR-1.** Once a month's GSTR-1 is filed, an owner locks that period. From then, no posting — including a cancellation — can be dated inside it. Unlocking is possible but admin-only and lands permanently in the Audit trail.

**Reports for the owners.** Trial balance to sanity-check the books balance, Receivables ageing to chase overdue builders, GSTR-1 for filing. Excel/PDF export buttons exist on several report screens as placeholders for now.

**Backups.** Supabase takes daily backups; a weekly `pg_dump` goes to a family Google Drive, encrypted; there's a documented restore-drill record and an offline fallback (bill by hand in a separate manual-number series if the app is ever down).

**Inviting a user.** Settings → Users & roles → Invite user: enter email, pick role (User — draft/post sales & receipts, advances ≤₹5,000, no cancellations/purchases/settings; or Admin — everything, TOTP required). They get a one-time sign-in link; there is no self-signup.

---

## 4. What the prototype does not do yet

- **Nothing is actually saved.** Reload the page and everything resets to the demo data above.
- **PDF, WhatsApp, Print, Excel, Tally-XML export buttons** are all placeholders — they don't produce a file.
- **E-way bill and e-invoice (IRN) generation** show the required fields but don't call the government NIC portal; that's Phase 3.
- **Telugu toggle** only swaps a handful of screen labels (nav, dashboard tiles/title) — item names, party names, and most screen content stay in English.
- **"Gannavaram" second godown** is demo data to show the multi-location UI; there's no real second physical location wired up yet.
- Several reports (P&L, balance sheet, GSTR-3B, rebate tracker, site-wise sales) show only a card with a description — clicking gives a toast, not a real screen.
- Sample numbers (balances, stock, invoice numbers) are invented for demo purposes and don't reconcile to any real business data.

---

## 5. Try it yourself — a 10-question checklist

1. On the new invoice, change the Tiscon 12mm line from 47 pcs to 50 pcs. **Expect:** kg becomes 533, and taxable/GST/total all update.
2. On the same invoice, lower the UltraTech quantity from 100 bags to 20. **Expect:** the total drops below ₹50,000 and the amber "E-way bill required" panel disappears; set it back to 100 and the panel returns.
3. Post that invoice. **Expect:** a toast naming the new invoice number and journal entry; you land on the posted invoice view showing the journal entry (debits = credits).
4. On Payments → Receive payment, type an amount, then click "Auto-allocate oldest first". **Expect:** the oldest open invoices fill first, the progress bar moves, and "unallocated" drops.
5. Change payment mode to Cheque. **Expect:** cheque number/date/bank fields appear.
6. Open a party's ledger (Parties screen) for Sri Venkateswara Constructions. **Expect:** ageing tiles show ₹1,02,400 in the 61–90 day bucket, matching the dashboard's overdue figure.
7. Open the Stock screen and click ACC Gold 50kg. **Expect:** its item ledger shows every purchase and sale movement with a running balance ending at 145 bags.
8. Go to Reports → Trial balance. **Expect:** the Debit and Credit totals at the bottom are identical.
9. On Staff, record a salary for someone with an outstanding advance. **Expect:** the "pays" amount shown is salary minus the advance, and the advance clears to zero after posting.
10. Go to Settings → Period locks. **Expect:** April to June show as Locked with their GSTR filing status, July is Open; the "Unlock (logged)" button is a placeholder in the prototype (in the real app it is admin-only and writes an Audit trail row, which you can see on the Audit trail tab).
