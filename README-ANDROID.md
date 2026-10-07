# Naisi Invoices — Android/Kotlin

This directory/branch is the native Android conversion of the existing Naisi Foods Invoice Generator.

## Branch isolation

This Android implementation is on the `android-kotlin` branch, created from `main`. The web implementation on `main` is intentionally left unchanged.

## Stack

- Kotlin
- Jetpack Compose
- Firebase Authentication
- Cloud Firestore
- Android PdfDocument
- Android location services
- CSV/Excel-compatible exports

## Firebase

The app uses the same Firebase project as the web app:

- Project: `naisi-invoices`
- Auth domain: `naisi-invoices.firebaseapp.com`
- Firestore collections: `config/roles`, `counters`, `orderCounters`, `products`, `customers`, `locations`, `users`, `orders`, `invoices`, `expenses`, `visits`, `stockMovements`

The existing web Firebase configuration is used for initialization so this branch does not require copying secrets into source control. For production distribution, register the Android application id `com.frost289.naisiinvoices` in the Firebase console and replace the programmatic Firebase app options with the generated Android configuration if your Firebase project requires an Android-specific app registration.

## Feature parity

The native app mirrors the original role-based workflows:

- email/password sign-in
- manager, sales rep, and delivery roles
- invoice numbering and order numbering
- customer management, duplicate detection, merging and weekly visit days
- products and live stock
- stock movement ledger
- order submission/approval/invoicing/delivery
- invoice PDF generation and sharing
- WhatsApp-ready PDF sharing through Android's share sheet
- visit logging and rep performance
- expense logging and summaries
- date-range business summaries
- profile names and manager role preview

The Android UI is deliberately mobile-first while keeping the original Naisi visual language: forest green, leaf green, cream/paper cards, amber accents and invoice-paper previews.
