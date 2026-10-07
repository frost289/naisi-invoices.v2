package com.frost289.naisiinvoices

import android.content.Context
import com.google.firebase.FirebaseApp
import com.google.firebase.auth.FirebaseAuth
import com.google.firebase.firestore.FirebaseFirestore

object Firebase {
    lateinit var auth: FirebaseAuth
    lateinit var db: FirebaseFirestore

    fun initialize(context: Context) {
        if (FirebaseApp.getApps(context).isEmpty()) {
            FirebaseApp.initializeApp(context)
        }
        auth = FirebaseAuth.getInstance()
        db = FirebaseFirestore.getInstance()
    }
}
