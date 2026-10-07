package com.frost289.naisiinvoices

import com.google.firebase.Timestamp
import com.google.firebase.firestore.FirebaseFirestore
import com.google.firebase.firestore.Query
import kotlinx.coroutines.tasks.await

class NaisiRepository(private val db: FirebaseFirestore) {
    private fun number(value: Any?): Double = (value as? Number)?.toDouble() ?: 0.0

    private fun line(data: Map<String, Any?>): LineItem = LineItem(
        qty = (data["qty"] as? Number)?.toDouble() ?: 0.0,
        desc = (data["desc"] as? String) ?: "",
        price = (data["price"] as? Number)?.toDouble() ?: 0.0,
        productName = data["productName"] as? String,
        packLabel = data["packLabel"] as? String,
        packQuantity = (data["packQuantity"] as? Number)?.toDouble(),
        productId = data["productId"] as? String
    )

    suspend fun role(email: String): String? {
        val data = db.collection("config").document("roles").get().await().data ?: return null
        return when {
            (data["managers"] as? List<*>)?.contains(email) == true -> "manager"
            (data["submitters"] as? List<*>)?.contains(email) == true -> "submitter"
            (data["deliverers"] as? List<*>)?.contains(email) == true -> "delivery"
            else -> null
        }
    }

    suspend fun products() = db.collection("products").orderBy("productName").get().await().documents.map { d ->
        Product(d.id, d.getString("productName").orEmpty(), d.getString("packLabel").orEmpty(),
            number(d.get("quantity")), number(d.get("price")), number(d.get("stockOnHand")))
    }

    suspend fun customers() = db.collection("customers").orderBy("name").get().await().documents.map { d ->
        Customer(d.id, d.getString("name").orEmpty(), d.getString("phone").orEmpty(),
            d.getString("location").orEmpty(), d.get("lat")?.let(::number), d.get("lng")?.let(::number),
            d.getBoolean("active") ?: true, d.getString("assignedDay"))
    }

    suspend fun invoices() = db.collection("invoices").orderBy("createdAt", Query.Direction.DESCENDING)
        .limit(25).get().await().documents.map { d ->
            Invoice(d.id, d.getString("invoiceNo").orEmpty(), d.getString("date").orEmpty(),
                d.getString("customer").orEmpty(), d.getString("customerId"),
                d.getString("phone").orEmpty(), d.getString("location").orEmpty(),
                d.getString("terms").orEmpty(), d.getString("providerPhone").orEmpty(),
                d.getString("notes").orEmpty(),
                (d.get("items") as? List<Map<String, Any?>>)?.map(::line) ?: emptyList(),
                number(d.get("grandTotal")))
        }

    suspend fun orders(role: String, uid: String): List<Order> {
        val query = if (role == "submitter") {
            db.collection("orders").whereEqualTo("createdBy", uid)
                .orderBy("createdAt", Query.Direction.DESCENDING)
        } else db.collection("orders").orderBy("createdAt", Query.Direction.DESCENDING)

        return query.limit(25).get().await().documents.map { d ->
            Order(d.id, d.getString("orderNo").orEmpty(), d.getString("status").orEmpty(),
                d.getString("customerId"), d.getString("customerName").orEmpty(),
                d.getString("customerPhone").orEmpty(), d.getString("customerLocation").orEmpty(),
                (d.get("items") as? List<Map<String, Any?>>)?.map(::line) ?: emptyList(),
                d.getString("notes").orEmpty(), number(d.get("grandTotal")),
                d.getString("createdBy").orEmpty(), d.getString("createdByEmail").orEmpty())
        }
    }

    suspend fun expenses(role: String, uid: String): List<Expense> {
        val query = if (role == "manager") db.collection("expenses")
        else db.collection("expenses").whereEqualTo("createdBy", uid)
        return query.orderBy("date", Query.Direction.DESCENDING).limit(25).get().await().documents.map { d ->
            Expense(d.id, d.getString("date").orEmpty(), d.getString("category").orEmpty(),
                number(d.get("amount")), d.getString("notes").orEmpty(),
                d.getString("createdBy").orEmpty(), d.getString("createdByEmail").orEmpty())
        }
    }

    suspend fun addCustomer(c: Customer, uid: String) {
        db.collection("customers").add(mapOf(
            "name" to normalizeText(c.name), "phone" to c.phone, "location" to normalizeText(c.location),
            "lat" to c.lat, "lng" to c.lng, "active" to true, "assignedDay" to c.assignedDay,
            "createdBy" to uid, "createdAt" to Timestamp.now(), "updatedAt" to Timestamp.now()
        )).await()
    }

    suspend fun addProduct(p: Product, uid: String) {
        db.collection("products").add(mapOf(
            "productName" to p.productName, "packLabel" to p.packLabel, "quantity" to p.quantity,
            "price" to p.price, "stockOnHand" to p.stockOnHand, "createdBy" to uid,
            "createdAt" to Timestamp.now(), "updatedAt" to Timestamp.now()
        )).await()
    }

    suspend fun addExpense(e: Expense, uid: String, email: String) {
        db.collection("expenses").add(mapOf(
            "date" to e.date, "category" to e.category, "amount" to e.amount, "notes" to e.notes,
            "createdBy" to uid, "createdByEmail" to email, "createdAt" to Timestamp.now(),
            "updatedAt" to Timestamp.now()
        )).await()
    }

    private fun itemMap(i: LineItem) = mapOf(
        "qty" to i.qty, "desc" to i.desc, "price" to i.price, "total" to i.total,
        "productName" to i.productName, "packLabel" to i.packLabel,
        "packQuantity" to i.packQuantity, "productId" to i.productId
    )

    suspend fun submitOrder(o: Order, uid: String, email: String): String {
        val ref = db.collection("orderCounters").document("naisiOrder")
        val no = db.runTransaction { tx ->
            val s = tx.get(ref)
            val n = s.getLong("counter") ?: 1L
            tx.set(ref, mapOf("counter" to n + 1))
            val year = java.util.Calendar.getInstance().get(java.util.Calendar.YEAR)
            "ORD-${year}-${n.toString().padStart(4, '0')}"
        }.await()

        db.collection("orders").add(mapOf(
            "orderNo" to no, "status" to "Submitted", "customerId" to o.customerId,
            "customerName" to o.customerName, "customerPhone" to o.customerPhone,
            "customerLocation" to o.customerLocation, "items" to o.items.map(::itemMap),
            "notes" to o.notes, "grandTotal" to o.items.sumOf { it.total }, "createdBy" to uid,
            "createdByEmail" to email, "createdAt" to Timestamp.now(), "updatedAt" to Timestamp.now(),
            "submittedAt" to Timestamp.now(), "approvedAt" to null, "rejectedAt" to null,
            "cancelledAt" to null, "invoicedAt" to null, "managerNotes" to "",
            "invoiceId" to null, "invoiceNo" to null
        )).await()
        return no
    }

    suspend fun addInvoice(i: Invoice, uid: String): String {
        val ref = db.collection("counters").document("naisiInvoice")
        val no = db.runTransaction { tx ->
            val s = tx.get(ref)
            val p = s.getString("prefix") ?: "NF-INV"
            val n = s.getLong("counter") ?: 1L
            tx.set(ref, mapOf("prefix" to p, "counter" to n + 1))
            invoiceNo(p, n)
        }.await()

        db.collection("invoices").add(mapOf(
            "invoiceNo" to no, "date" to i.date, "customer" to i.customer,
            "customerId" to i.customerId, "phone" to i.phone, "location" to i.location,
            "terms" to i.terms, "providerPhone" to i.providerPhone, "notes" to i.notes,
            "items" to i.items.map(::itemMap), "grandTotal" to i.items.sumOf { it.total },
            "createdBy" to uid, "createdAt" to Timestamp.now()
        )).await()
        return no
    }

    suspend fun approveOrderWithStock(o: Order, uid: String, email: String) {
        db.runTransaction { tx ->
            val orderRef = db.collection("orders").document(o.id)
            val os = tx.get(orderRef)
            if (!os.exists() || os.getString("status") != "Submitted")
                throw IllegalStateException("This order is no longer Submitted.")

            val tracked = o.items.filter { it.productId != null }
            val snaps = tracked.map { tx.get(db.collection("products").document(it.productId!!)) }

            tracked.forEachIndexed { i, item ->
                val snap = snaps[i]
                if (!snap.exists()) throw IllegalStateException("Product ${item.desc} was not found.")
                val have = number(snap.get("stockOnHand"))
                if (item.qty > have)
                    throw IllegalStateException("Insufficient stock for ${item.desc}: need ${item.qty}, have ${have}")
            }

            tx.update(orderRef, mapOf(
                "status" to "Approved", "stockApplied" to true,
                "approvedAt" to Timestamp.now(), "updatedAt" to Timestamp.now()
            ))

            tracked.forEachIndexed { i, item ->
                val snap = snaps[i]
                val productRef = db.collection("products").document(item.productId!!)
                val old = number(snap.get("stockOnHand"))
                val next = old - item.qty
                tx.update(productRef, mapOf("stockOnHand" to next, "updatedAt" to Timestamp.now()))
                tx.set(db.collection("stockMovements").document(), mapOf(
                    "productId" to item.productId,
                    "productName" to snap.getString("productName").orEmpty(),
                    "packLabel" to snap.getString("packLabel").orEmpty(),
                    "type" to "order-approved", "delta" to -item.qty,
                    "previousStock" to old, "newStock" to next, "reason" to "",
                    "orderId" to o.id, "orderNo" to o.orderNo, "createdBy" to uid,
                    "createdByEmail" to email, "createdAt" to Timestamp.now()
                ))
            }
        }.await()
    }

    suspend fun markOrderInvoiced(id: String, invoiceId: String, invoiceNo: String) {
        db.runTransaction { tx ->
            val ref = db.collection("orders").document(id)
            val s = tx.get(ref)
            if (!s.exists() || s.getString("status") != "Approved")
                throw IllegalStateException("Order is no longer Approved.")
            tx.update(ref, mapOf(
                "status" to "Invoiced", "invoiceId" to invoiceId, "invoiceNo" to invoiceNo,
                "invoicedAt" to Timestamp.now(), "updatedAt" to Timestamp.now()
            ))
        }.await()
    }

    suspend fun markDelivered(id: String, uid: String, email: String) {
        db.runTransaction { tx ->
            val ref = db.collection("orders").document(id)
            val s = tx.get(ref)
            if (!s.exists() || s.getString("status") != "Invoiced")
                throw IllegalStateException("This order is no longer ready for delivery.")
            tx.update(ref, mapOf(
                "status" to "Delivered", "deliveredBy" to uid,
                "deliveredByEmail" to email, "deliveredAt" to Timestamp.now(),
                "updatedAt" to Timestamp.now()
            ))
        }.await()
    }

    suspend fun addVisit(v: Visit, uid: String, email: String, customerId: String) {
        db.collection("visits").add(mapOf(
            "customerId" to customerId, "customerName" to v.customerName,
            "repId" to uid, "repEmail" to email, "date" to nowDate(),
            "outcome" to v.outcome, "reasonNoOrder" to v.reason.ifBlank { null },
            "reasonNotes" to v.notes, "orderId" to null, "orderNo" to null,
            "createdAt" to Timestamp.now()
        )).await()
    }
}