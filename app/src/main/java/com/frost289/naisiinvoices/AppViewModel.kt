package com.frost289.naisiinvoices
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.google.firebase.auth.FirebaseAuth
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.tasks.await

data class UiState(
 val loading:Boolean=false,val error:String?=null,val userEmail:String="",val uid:String="",val role:String?=null,
 val tab:String="Home",val products:List<Product> = emptyList(),val customers:List<Customer> = emptyList(),
 val invoices:List<Invoice> = emptyList(),val orders:List<Order> = emptyList(),val expenses:List<Expense> = emptyList(),
 val signedIn:Boolean=false
)
class AppViewModel:ViewModel(){
 private val repo by lazy{NaisiRepository(Firebase.db)};private val auth=FirebaseAuth.getInstance()
 private val _state=MutableStateFlow(UiState());val state=_state.asStateFlow()
 fun signIn(email:String,password:String)=viewModelScope.launch{_state.value=_state.value.copy(loading=true,error=null);try{
  auth.signInWithEmailAndPassword(email.trim(),password).await();val u=auth.currentUser?:error("Sign-in failed.");return@launch
  val r=repo.role(u.email?:"");if(r==null){auth.signOut();error("Your account has no Naisi Foods role.");return@launch}
  _state.value=_state.value.copy(loading=false,signedIn=true,userEmail=u.email?:"",uid=u.uid,role=r);loadAll()
 }catch(e:Exception){error(e.message)}}
 fun signOut(){auth.signOut();_state.value=UiState()}
 fun select(t:String){_state.value=_state.value.copy(tab=t)}
 fun loadAll()=viewModelScope.launch{try{_state.value=_state.value.copy(loading=true);val s=_state.value;_state.value=s.copy(loading=false,products=repo.products(),customers=repo.customers(),invoices=repo.invoices(),orders=repo.orders(s.role?:"",s.uid),expenses=repo.expenses(s.role?:"",s.uid))}catch(e:Exception){error(e.message)}}
 fun addCustomer(c:Customer)=viewModelScope.launch{try{repo.addCustomer(c,_state.value.uid);loadAll()}catch(e:Exception){error(e.message)}}
 fun addProduct(p:Product)=viewModelScope.launch{try{repo.addProduct(p,_state.value.uid);loadAll()}catch(e:Exception){error(e.message)}}
 fun addExpense(e:Expense)=viewModelScope.launch{try{repo.addExpense(e,_state.value.uid,_state.value.userEmail);loadAll()}catch(x:Exception){error(x.message)}}
 fun submitOrder(o:Order,onDone:(String)->Unit={})=viewModelScope.launch{try{val n=repo.submitOrder(o,_state.value.uid,_state.value.userEmail);onDone(n);loadAll()}catch(e:Exception){error(e.message)}}
 fun addVisit(v:Visit,customerId:String,onDone:()->Unit={})=viewModelScope.launch{try{repo.addVisit(v,_state.value.uid,_state.value.userEmail,customerId);onDone();loadAll()}catch(e:Exception){error(e.message)}}
 fun addInvoice(i:Invoice,orderId:String?=null,onDone:(String)->Unit={})=viewModelScope.launch{try{val n=repo.addInvoice(i,_state.value.uid);if(orderId!=null){val inv=repo.invoices().firstOrNull{it.invoiceNo==n};if(inv!=null)repo.markOrderInvoiced(orderId,inv.id,n)};onDone(n);loadAll()}catch(e:Exception){error(e.message)}}
 fun approveOrder(o:Order)=viewModelScope.launch{try{repo.approveOrderWithStock(o,_state.value.uid,_state.value.userEmail);loadAll()}catch(e:Exception){error(e.message)}}
 fun deliverOrder(id:String)=viewModelScope.launch{try{repo.markDelivered(id,_state.value.uid,_state.value.userEmail);loadAll()}catch(e:Exception){error(e.message)}}
 private fun error(m:String?){_state.value=_state.value.copy(loading=false,error=m?: "Unknown error")}
 fun clearError(){_state.value=_state.value.copy(error=null)}
}
