package com.frost289.naisiinvoices
import android.content.Context
import com.google.firebase.FirebaseApp
import com.google.firebase.FirebaseOptions
import com.google.firebase.auth.FirebaseAuth
import com.google.firebase.firestore.FirebaseFirestore

object Firebase {
    lateinit var auth: FirebaseAuth
    lateinit var db: FirebaseFirestore
    fun initialize(context: Context) {
        if (FirebaseApp.getApps(context).isEmpty()) {
            val options=FirebaseOptions.Builder()
                .setApiKey("AIzaSyACgsqYVZ2qL_UvtQXu6bPpY48qeZw")
                .setProjectId("naisi-invoices")
                .setApplicationId("1:555183502792:android:naisiinvoices")
                .setStorageBucket("naisi-invoices.firebasestorage.app").build()
            FirebaseApp.initializeApp(context,options)
        }
        auth=FirebaseAuth.getInstance(); db=FirebaseFirestore.getInstance()
    }
}
