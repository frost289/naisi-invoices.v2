package com.frost289.naisiinvoices

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.google.firebase.auth.FirebaseAuth
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.tasks.await

data class UiState(
    val loading: Boolean = false,
    val error: String? = null,
    val userEmail: String = "",
    val uid: String = "",
    val role: String? = null,
    val tab: String = "Home",
    val products: List<Product> = emptyList(),
    val customers: List<Customer> = emptyList(),
    val invoices: List<Invoice> = emptyList(),
    val orders: List<Order> = emptyList(),
    val expenses: List<Expense> = emptyList(),
    val signedIn: Boolean = false
)

class AppViewModel : ViewModel() {
    private val repo by lazy { NaisiRepository(Firebase.db) }
    private val auth = FirebaseAuth.getInstance()

    private val _state = MutableStateFlow(UiState())
    val state = _state.asStateFlow()

    fun signIn(email: String, password: String) = viewModelScope.launch {
        _state.value = _state.value.copy(loading = true, error = null)

        try {
            auth.signInWithEmailAndPassword(email.trim(), password).await()

            val user = auth.currentUser
            if (user == null) {
                error("Sign-in failed.")
                return@launch
            }

            val role = repo.role(user.email.orEmpty())
            if (role == null) {
                auth.signOut()
                error("Your account has no Naisi Foods role.")
                return@launch
            }

            _state.value = _state.value.copy(
                loading = false,
                signedIn = true,
                userEmail = user.email.orEmpty(),
                uid = user.uid,
                role = role
            )
            loadAll()
        } catch (e: Exception) {
            error(e.message)
        }
    }

    fun signOut() {
        auth.signOut()
        _state.value = UiState()
    }

    fun select(tab: String) {
        _state.value = _state.value.copy(tab = tab)
    }

    fun loadAll() = viewModelScope.launch {
        try {
            _state.value = _state.value.copy(loading = true)
            val current = _state.value
            _state.value = current.copy(
                loading = false,
                products = repo.products(),
                customers = repo.customers(),
                invoices = repo.invoices(),
                orders = repo.orders(current.role.orEmpty(), current.uid),
                expenses = repo.expenses(current.role.orEmpty(), current.uid)
            )
        } catch (e: Exception) {
            error(e.message)
        }
    }

    fun addCustomer(customer: Customer) = viewModelScope.launch {
        try {
            repo.addCustomer(customer, _state.value.uid)
            loadAll()
        } catch (e: Exception) {
            error(e.message)
        }
    }

    fun addProduct(product: Product) = viewModelScope.launch {
        try {
            repo.addProduct(product, _state.value.uid)
            loadAll()
        } catch (e: Exception) {
            error(e.message)
        }
    }

    fun addExpense(expense: Expense) = viewModelScope.launch {
        try {
            repo.addExpense(expense, _state.value.uid, _state.value.userEmail)
            loadAll()
        } catch (e: Exception) {
            error(e.message)
        }
    }

    fun submitOrder(order: Order, onDone: (String) -> Unit = {}) = viewModelScope.launch {
        try {
            val orderNo = repo.submitOrder(
                order,
                _state.value.uid,
                _state.value.userEmail
            )
            onDone(orderNo)
            loadAll()
        } catch (e: Exception) {
            error(e.message)
        }
    }

    fun addVisit(
        visit: Visit,
        customerId: String,
        onDone: () -> Unit = {}
    ) = viewModelScope.launch {
        try {
            repo.addVisit(
                visit,
                _state.value.uid,
                _state.value.userEmail,
                customerId
            )
            onDone()
            loadAll()
        } catch (e: Exception) {
            error(e.message)
        }
    }

    fun addInvoice(
        invoice: Invoice,
        orderId: String? = null,
        onDone: (String) -> Unit = {}
    ) = viewModelScope.launch {
        try {
            val invoiceNo = repo.addInvoice(invoice, _state.value.uid)

            if (orderId != null) {
                val savedInvoice = repo.invoices().firstOrNull { it.invoiceNo == invoiceNo }
                if (savedInvoice != null) {
                    repo.markOrderInvoiced(orderId, savedInvoice.id, invoiceNo)
                }
            }

            onDone(invoiceNo)
            loadAll()
        } catch (e: Exception) {
            error(e.message)
        }
    }

    fun approveOrder(order: Order) = viewModelScope.launch {
        try {
            repo.approveOrderWithStock(
                order,
                _state.value.uid,
                _state.value.userEmail
            )
            loadAll()
        } catch (e: Exception) {
            error(e.message)
        }
    }

    fun deliverOrder(orderId: String) = viewModelScope.launch {
        try {
            repo.markDelivered(
                orderId,
                _state.value.uid,
                _state.value.userEmail
            )
            loadAll()
        } catch (e: Exception) {
            error(e.message)
        }
    }

    private fun error(message: String?) {
        _state.value = _state.value.copy(
            loading = false,
            error = message ?: "Unknown error"
        )
    }

    fun clearError() {
        _state.value = _state.value.copy(error = null)
    }
}
