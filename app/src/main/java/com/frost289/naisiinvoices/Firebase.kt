package com.frost289.naisiinvoices

import android.content.Context
import com.google.firebase.FirebaseApp
import com.google.firebase.FirebaseOptions
import com.google.firebase.auth.FirebaseAuth
import com.google.firebase.firestore.FirebaseFirestore

/*
 * Uses the existing Naisi Firebase project so the native app can share
 * the same Auth/Firestore data as the original application.
 *
 * For a production Android registration, replace applicationId below
 * with the Android app's mobilesdk_app_id from Firebase Console, or
 * move to google-services.json as described in README.md.
 */
object Firebase {
    private const val API_KEY = "AIzaSyACgsYqYfrZVZ2qL_UvtQXu6bPpY48qeZw"
    private const val PROJECT_ID = "naisi-invoices"
    private const val EXISTING_CLIENT_APP_ID = "1:555183502792:web:a9e1d1329e45eedc43bcfd"

    lateinit var auth: FirebaseAuth
    lateinit var db: FirebaseFirestore

    fun initialize(context: Context) {
        if (FirebaseApp.getApps(context).isEmpty()) {
            val options = FirebaseOptions.Builder()
                .setApiKey(API_KEY)
                .setProjectId(PROJECT_ID)
                .setApplicationId(EXISTING_CLIENT_APP_ID)
                .setStorageBucket("naisi-invoices.firebasestorage.app")
                .build()
            FirebaseApp.initializeApp(context, options)
        }
        auth = FirebaseAuth.getInstance()
        db = FirebaseFirestore.getInstance()
    }
}
