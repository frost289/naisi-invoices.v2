# Naisi Foods — Android App

This branch contains the native Android/Kotlin version of the Naisi Foods invoice and sales application.

**Branch:** `android-kotlin`  
**Package name:** `com.frost289.naisiinvoices`  
**Minimum Android:** API 26 (Android 8.0)  
**Compile/target SDK:** 37  
**UI:** Jetpack Compose  
**Backend:** Firebase Authentication + Cloud Firestore

The original web application on `main` is not modified by this branch.

---

## 1. What the Android app does

Naisi is a role-based sales, ordering, stock, invoicing and delivery app.

### Sales Rep

1. Sign in with the rep's email and password.
2. Open **Log Visit**.
3. Select an active customer.
4. Choose **Order Placed** or **No Order**.
5. For an order, add products and quantities.
6. Submit the order and visit record.
7. The order receives an order number such as `ORD-2026-0001`.
8. The rep can track submitted orders under **My Orders**.

### Manager

1. Sign in as a manager.
2. Open **Orders**.
3. Review an order and approve it.
4. Approval checks stock and deducts tracked product stock in a Firestore transaction.
5. The stock movement is recorded in `stockMovements`.
6. Generate the invoice from the approved order.
7. The invoice receives a sequential number such as `NF-INV-2026-0001`.
8. The order is moved to **Invoiced**.
9. Open **Invoices** to view invoices and share a PDF.
10. Use **Customers**, **Products**, **Expenses**, and **Summary** for the management data currently ported to Android.

### Delivery

The delivery role sees orders whose status is **Invoiced**. Opening one lets the delivery user mark it **Delivered**.

---

## 2. Firestore data used

The Android app uses the same business data model as the existing application.

Main collections:

- `config/roles`
- `counters`
- `orderCounters`
- `products`
- `customers`
- `locations`
- `users`
- `orders`
- `invoices`
- `expenses`
- `visits`
- `stockMovements`

Do not rename these collections without changing the Android repository and the existing Firestore security rules.

---

## 3. Firebase setup before distributing the app

The current Android branch contains Firebase client configuration for the existing Naisi Firebase project so the project can be developed and built without copying the web application's source tree.

For a proper production Android registration, register this package in the Firebase project:

`com.frost289.naisiinvoices`

In Firebase Console:

1. Open the existing **naisi-invoices** project.
2. Add an **Android app**.
3. Enter package name `com.frost289.naisiinvoices`.
4. Download the generated `google-services.json`.
5. Put the file in the Android module:
   `app/google-services.json`
6. For the long-term production configuration, replace the programmatic Firebase client app ID in `Firebase.kt` with the Android app's `mobilesdk_app_id`, or migrate the project to the standard Google Services Gradle plugin setup using the downloaded JSON.

Firebase's documentation recommends registering the Android package and adding `google-services.json`; the package name is case-sensitive and is tied to the registered app.

### Authentication

The existing app uses **email/password authentication**. Make sure Email/Password sign-in is enabled in Firebase Authentication.

### Firestore

The Android app expects the existing Firestore data and security rules to remain available. Do not weaken rules simply to make the APK work.

---

## 4. Open the project in Android Studio

Install the latest Android Studio and make sure the Android SDK/platform needed by this branch is installed.

Then:

1. Clone the repository.
2. Checkout `android-kotlin`.
3. Open the repository folder in Android Studio.
4. Let Gradle sync.
5. Install/accept Android SDK 37 when Android Studio asks for it.
6. Connect an Android phone with USB debugging enabled, or start an emulator.
7. Press **Run**.

The project uses Java/JDK 17. The Android Gradle Plugin version used here is 9.1.1, which supports Android API 37; Gradle 9.3.1 is used by the build workflow.

---

## 5. Make a test APK

The easiest way in Android Studio:

**Build → Build APK(s)**

For a command-line build with Gradle 9.3.1 installed:

```bash
gradle assembleDebug
```

The debug APK is generated at:

`app/build/outputs/apk/debug/app-debug.apk`

The GitHub Actions workflow on this branch also builds the debug APK and uploads it as the workflow artifact **naisi-invoices-debug-apk**.

### Installing the debug APK on a phone

Copy `app-debug.apk` to the phone and open it.

Android may ask the user to allow installation from the source being used (for example, the browser or file manager). Only install APKs from a trusted source.

ADB installation for your own test phone:

```bash
adb install -r app/build/outputs/apk/debug/app-debug.apk
```

---

## 6. Make the real release APK

Do **not** use the debug APK as the public production build.

Android requires distributable APKs to be digitally signed. Keep the release keystore and private key somewhere safe; losing the signing key can prevent you from shipping updates to the same application ID.

### Android Studio release workflow

1. Open the project.
2. Choose **Build → Generate Signed Bundle / APK**.
3. Choose **APK**.
4. Select the `app` module.
5. Create a new keystore if you do not already have one.
6. Store the keystore somewhere outside the repository.
7. Choose the **release** build variant.
8. Build the APK.

The resulting file will normally be under:

`app/build/outputs/apk/release/app-release.apk`

Android Studio's official release flow supports both signed APKs and signed App Bundles.

### Important signing rule

Never commit:

- `*.jks`
- `*.keystore`
- passwords
- private signing keys

The repository's `.gitignore` already excludes common keystore files.

Also keep the same **application ID** forever once the app is distributed:

`com.frost289.naisiinvoices`

Changing the application ID creates a different Android application and is not an upgrade of the existing one.

---

## 7. APK vs AAB

Use a **signed APK** when you want to give the installation file directly to a small set of users or distribute it through your own website/file-sharing system.

Use an **Android App Bundle (`.aab`)** when publishing through Google Play. Google Play uses App Bundles to generate optimized APKs for users' devices, and Play App Signing is part of the normal Play publishing flow.

For a Play build:

**Build → Generate Signed Bundle / APK → Android App Bundle**

The bundle will normally be:

`app/build/outputs/bundle/release/app-release.aab`

---

## 8. Distributing the APK directly to users

A simple first distribution flow is:

1. Build a signed **release APK**.
2. Test it on at least one physical phone.
3. Upload the APK to your website or trusted download location.
4. Give users the download link.
5. Users install the APK.
6. When you publish an update, increase `versionCode` in `app/build.gradle.kts` and build a new signed release using the **same signing key**.

Android supports distribution outside Google Play. Android's developer-verification rollout is now active in selected regions and is scheduled to expand globally during 2027, so registering the developer identity and package name is a good long-term distribution step. Developers distributing exclusively outside Google Play can use the Android Developer Console, which currently offers a special account type for students/hobbyists with fewer verification requirements and no fee.

---

## 9. GitHub Actions APK

Every push to `android-kotlin` runs:

`gradle assembleDebug`

and uploads:

`app-debug.apk`

as the workflow artifact **naisi-invoices-debug-apk**.

This is intended for development/testing, not as the public release APK.

A future production CI workflow can be added once a release keystore is stored securely as GitHub Actions secrets. Never put the private signing key directly in the repository.

---

## 10. Updating the app

For every release:

1. Change `versionCode` to the next integer.
2. Update `versionName` if needed.
3. Test login for all three roles.
4. Test order creation.
5. Test manager approval and stock deduction.
6. Test invoice creation and PDF sharing.
7. Test delivery completion.
8. Test on a real phone.
9. Build the signed release APK/AAB.
10. Distribute it.

Example:

```kotlin
defaultConfig {
    applicationId = "com.frost289.naisiinvoices"
    versionCode = 2
    versionName = "1.1.0"
}
```

---

## 11. Current Android feature scope

The native branch currently ports the core workflows:

- email/password login
- manager / sales rep / delivery roles
- sales rep visit logging
- order creation
- order numbering
- manager order approval
- transactional stock deduction
- stock movement creation
- invoice numbering
- invoice creation
- invoice PDF generation
- Android share sheet for invoice PDFs
- delivery completion
- customer list and customer creation
- product list and product creation
- expense logging
- summary dashboard

The following parts of the original web app are not yet fully ported to the native UI and should be completed before claiming 100% feature parity:

- the full manager performance report
- full date-range reporting/export to Excel
- customer duplicate/merge tooling
- map pin picker and richer map actions
- invoice editing
- product editing/deleting
- expense editing/deleting
- full visit-history screen
- manager role-preview controls
- some pagination/live-sync behavior

This is intentional: the Android branch is kept native and free of the old web application's JavaScript/Vite dependencies rather than carrying both applications in one build.

---

## 12. Troubleshooting

### Gradle says the Android SDK is missing

Install Android API 37 from Android Studio's SDK Manager and sync again.

### Firebase fails during startup

Check that:

- the Firebase project is **naisi-invoices**
- the app has a valid Firebase client configuration
- the Android package is `com.frost289.naisiinvoices`
- Authentication is enabled
- Firestore is enabled
- your Firebase security rules allow the signed-in role to perform the operation

Firebase requires valid API key, Project ID and Application ID values for initialization. For a proper Android registration, use the Android app's `google-services.json` / `mobilesdk_app_id`.

### Users cannot update an older APK

Make sure you are:

- using the same `applicationId`
- signing the new APK with the same release key
- increasing `versionCode`

---

## 13. Release checklist

Before sending the APK to real users:

- [ ] Firebase Android app registered
- [ ] Production Firebase configuration installed
- [ ] Email/password authentication tested
- [ ] Firestore rules tested
- [ ] Real phone tested
- [ ] Release keystore created
- [ ] Keystore backed up securely
- [ ] Release APK signed
- [ ] Version code increased
- [ ] Invoice PDF sharing tested
- [ ] Manager approval/stock deduction tested
- [ ] Delivery workflow tested
- [ ] APK uploaded to the intended distribution channel
- [ ] Developer verification/package registration planned for wider distribution

---

## Official documentation

- Firebase Android setup: https://firebase.google.com/docs/android/setup
- Firebase Google Services plugin: https://firebase.google.com/docs/android/google-services-plugin-and-file
- Android prepare for release: https://developer.android.com/studio/publish/preparing
- Android app signing: https://developer.android.com/studio/publish/app-signing
- Android developer verification: https://developer.android.com/developer-verification
