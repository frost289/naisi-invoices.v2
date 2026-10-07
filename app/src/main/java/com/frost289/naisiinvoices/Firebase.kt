package com.frost289.naisiinvoices

import android.content.Context
import com.google.firebase.FirebaseApp
import com.google.firebase.FirebaseOptions
import com.google.firebase.auth.FirebaseAuth
import com.google.firebase.firestore.FirebaseFirestore

/*
 * Uses the registered Android app in the existing Naisi Firebase project.
 *
 * These values come from the Android app's google-services.json. The JSON file
 * itself is intentionally kept out of the repository; the required client
 * configuration is embedded here so GitHub Actions and fresh checkouts can
 * build without a private CI configuration file.
 */
object Firebase {
    private const val API_KEY = "AIzaSyChcP-S9O_O46Oy2bRSGWwavnzhX6drp_4"
    private const val PROJECT_ID = "naisi-invoices"
    private const val ANDROID_APP_ID = "1:555183502792:android:e818d480dac74ec443bcfd"
    private const val STORAGE_BUCKET = "naisi-invoices.firebasestorage.app"

    lateinit var auth: FirebaseAuth
    lateinit var db: FirebaseFirestore

    fun initialize(context: Context) {
        if (FirebaseApp.getApps(context).isEmpty()) {
            val options = FirebaseOptions.Builder()
                .setApiKey(API_KEY)
                .setProjectId(PROJECT_ID)
                .setApplicationId(ANDROID_APP_ID)
                .setStorageBucket(STORAGE_BUCKET)
                .build()
            FirebaseApp.initializeApp(context, options)
        }
        auth = FirebaseAuth.getInstance()
        db = FirebaseFirestore.getInstance()
    }
}
