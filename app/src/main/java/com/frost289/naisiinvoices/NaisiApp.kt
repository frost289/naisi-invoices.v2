package com.frost289.naisiinvoices
import android.content.Context
import android.content.Intent
import android.graphics.Paint
import android.graphics.pdf.PdfDocument
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.core.content.FileProvider
import java.io.File

private val Forest=Color(0xFF14401F);private val Forest2=Color(0xFF1F5C30);private val Leaf=Color(0xFF4CAF50);private val Cream=Color(0xFFF6F4EC);private val Paper=Color(0xFFFFFDF8);private val Muted=Color(0xFF6B7568);private val Amber=Color(0xFFC98A2C)

@Composable fun NaisiApp(vm:AppViewModel){
 val s by vm.state.collectAsState()
 MaterialTheme(colorScheme=lightColorScheme(primary=Forest2,secondary=Amber,background=Cream,surface=Paper,onSurface=Color(0xFF17241A))){
  if(!s.signedIn) Login(s,vm) else Workspace(s,vm)
 }
}
@Composable private fun Login(s:UiState,vm:AppViewModel){
 var email by remember{mutableStateOf("")};var pass by remember{mutableStateOf("")}
 Box(Modifier.fillMaxSize().background(Cream),contentAlignment=Alignment.Center){Card(Modifier.padding(22.dp).fillMaxWidth(),shape=RoundedCornerShape(16.dp)){Column(Modifier.padding(22.dp),verticalArrangement=Arrangement.spacedBy(12.dp)){
  Image(painterResource(R.drawable.naisi_logo),contentDescription="Naisi Foods",modifier=Modifier.fillMaxWidth().height(110.dp),contentScale=ContentScale.Fit)
  Text("Invoice & Sales Management",color=Muted)
  OutlinedTextField(email,{email=it},label={Text("Email")},modifier=Modifier.fillMaxWidth())
  OutlinedTextField(pass,{pass=it},label={Text("Password")},modifier=Modifier.fillMaxWidth())
  s.error?.let{Text(it,color=MaterialTheme.colorScheme.error,fontSize=12.sp)}
  Button({vm.signIn(email,pass)},enabled=!s.loading&&email.isNotBlank()&&pass.isNotBlank(),modifier=Modifier.fillMaxWidth().height(50.dp)){Text(if(s.loading)"Signing in…" else "Sign In")}
 }}}
}
@OptIn(ExperimentalMaterial3Api::class)
@Composable private fun Workspace(s:UiState,vm:AppViewModel){
 val manager=s.role=="manager";val delivery=s.role=="delivery"
 val tabs=when{s.role=="manager"->listOf("Home","Orders","Invoices","Customers","Products","Expenses","Summary");delivery->listOf("Home","Deliveries","Expenses");else->listOf("Home","My Orders","Customers","Log Visit","My Visits","Expenses")}
 Scaffold(topBar={TopAppBar(title={Row(verticalAlignment=Alignment.CenterVertically,horizontalArrangement=Arrangement.spacedBy(10.dp)){Image(painterResource(R.drawable.naisi_logo),contentDescription="Naisi Foods",modifier=Modifier.height(42.dp).width(88.dp),contentScale=ContentScale.Fit);Column{Text(if(manager)"Management" else if(delivery)"Delivery" else "Sales Rep",fontSize=11.sp,color=Leaf)}}},actions={TextButton(vm::signOut){Text("Log Out",color=Color.White)}},colors=TopAppBarDefaults.topAppBarColors(containerColor=Forest,titleContentColor=Color.White))},
 bottomBar={NavigationBar{tabs.take(5).forEach{t->NavigationBarItem(selected=s.tab==t,onClick={vm.select(t)},icon={Text(icon(t))},label={Text(t)})}}},containerColor=Cream){pad->Column(Modifier.padding(pad).fillMaxSize()){
  if(tabs.size>5)Row(Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()).background(Color(0xFFEAE5D7)).padding(4.dp)){tabs.forEach{t->FilterChip(s.tab==t,{vm.select(t)},label={Text(t)},modifier=Modifier.padding(3.dp))}}
  s.error?.let{Text(it,Modifier.fillMaxWidth().background(Color(0xFFFFE4E0)).padding(8.dp),color=Color(0xFFB3261E),fontSize=12.sp)}
  when(s.tab){"Home"->Home(s);"Orders"->Orders(s,vm,true);"Deliveries"->Orders(s,vm,false);"My Orders"->Orders(s,vm,false);"Invoices"->Invoices(s);"Customers"->Customers(s,vm);"Products"->Products(s,vm);"Expenses"->Expenses(s,vm);"Log Visit"->VisitLog(s,vm);"My Visits"->Text("Visit history",Modifier.padding(16.dp),color=Muted);"Summary"->Summary(s);else->Home(s)}
 }}
}
private fun icon(t:String)=when(t){"Home"->"⌂";"Orders"->"□";"Deliveries"->"↗";"Invoices"->"▤";"Customers"->"♙";"Products"->"▦";"Expenses"->"₵";"Log Visit"->"✓";"My Visits"->"☷";else->"•"}

@Composable private fun Home(s:UiState){LazyColumn(Modifier.fillMaxSize().padding(16.dp),verticalArrangement=Arrangement.spacedBy(12.dp)){item{Text("Welcome back",fontSize=24.sp,fontWeight=FontWeight.Bold,color=Forest)};item{Row(horizontalArrangement=Arrangement.spacedBy(8.dp)){Metric("Products",s.products.size.toString(),Modifier.weight(1f));Metric("Customers",s.customers.count{it.active}.toString(),Modifier.weight(1f));Metric("Orders",s.orders.size.toString(),Modifier.weight(1f))}};item{Row(horizontalArrangement=Arrangement.spacedBy(8.dp)){Metric("Invoices",s.invoices.size.toString(),Modifier.weight(1f));Metric("Submitted",s.orders.count{it.status=="Submitted"}.toString(),Modifier.weight(1f));Metric("Approved",s.orders.count{it.status=="Approved"}.toString(),Modifier.weight(1f))}};item{Info("Workflow",if(s.role=="submitter")"Log visits, create orders, then track My Orders." else "Review orders, manage stock, generate invoices, and review reports.")}}}
@Composable private fun Metric(a:String,b:String,modifier:Modifier=Modifier){Card(modifier){Column(Modifier.padding(12.dp)){Text(a,fontSize=11.sp,color=Muted);Text(b,fontSize=22.sp,fontWeight=FontWeight.Bold,color=Forest)}}}
@Composable private fun Info(a:String,b:String){Card(colors=CardDefaults.cardColors(containerColor=Color(0xFFEEF6EA))){Column(Modifier.padding(15.dp)){Text(a,color=Muted,fontSize=12.sp);Text(b,fontWeight=FontWeight.Bold,color=Forest)}}}
@Composable private fun Orders(s:UiState,vm:AppViewModel,manager:Boolean){
 var selected by remember{mutableStateOf<Order?>(null)}
 val visible=if(s.role=="delivery")s.orders.filter{it.status=="Invoiced"}else s.orders
 if(selected!=null)OrderDetail(selected!!,s,vm){selected=null}else LazyColumn(Modifier.fillMaxSize().padding(12.dp),verticalArrangement=Arrangement.spacedBy(8.dp)){
  item{Text(if(s.role=="delivery")"Deliveries" else if(manager)"Orders" else "My Orders",fontSize=23.sp,fontWeight=FontWeight.Bold,color=Forest)}
  items(visible){o->Card(Modifier.fillMaxWidth().clickable{selected=o}){Column(Modifier.padding(13.dp)){Row(Modifier.fillMaxWidth(),horizontalArrangement=Arrangement.SpaceBetween){Text(o.orderNo,fontWeight=FontWeight.Bold,color=Forest);Status(o.status)};Text(o.customerName);Text(mwk(o.grandTotal),fontWeight=FontWeight.Bold);Text(o.customerLocation,color=Muted,fontSize=12.sp)}}}
  if(visible.isEmpty())item{Text("No orders yet.",Modifier.padding(24.dp),color=Muted)}
 }}
@Composable private fun OrderDetail(o:Order,s:UiState,vm:AppViewModel,back:()->Unit){
 var invoice by remember{mutableStateOf(false)}
 LazyColumn(Modifier.fillMaxSize().padding(16.dp),verticalArrangement=Arrangement.spacedBy(10.dp)){
  item{Text("${o.orderNo}",fontSize=24.sp,fontWeight=FontWeight.Bold,color=Forest);Text(o.customerName,fontWeight=FontWeight.Bold);Text(o.customerPhone);Text(o.customerLocation,color=Muted);Status(o.status)}
  item{Card{Column(Modifier.padding(14.dp)){o.items.forEach{Text("${it.qty} × ${it.desc} — ${mwk(it.total)}")};Divider();Text("Grand Total ${mwk(o.grandTotal)}",fontWeight=FontWeight.Bold,color=Forest)}}}
  item{Row(horizontalArrangement=Arrangement.spacedBy(8.dp)){Button(back){Text("Back")};if(s.role=="manager"&&o.status=="Submitted")Button({vm.approveOrder(o);back()}){Text("Approve")};if(s.role=="manager"&&o.status=="Approved")Button({invoice=true}){Text("Generate Invoice")};if(s.role=="delivery"&&o.status=="Invoiced")Button({vm.deliverOrder(o.id);back()}){Text("Mark Delivered")}}}
  if(invoice)item{InvoiceForm(o,vm,back)}
 }}
@Composable private fun InvoiceForm(o:Order,vm:AppViewModel,done:()->Unit){
 var date by remember{mutableStateOf(nowDate())};var terms by remember{mutableStateOf("CASH ON DELIVERY (COD)")};var phone by remember{mutableStateOf("")}
 Column(verticalArrangement=Arrangement.spacedBy(8.dp)){Text("Invoice details",fontSize=19.sp,fontWeight=FontWeight.Bold,color=Forest);OutlinedTextField(date,{date=it},label={Text("Date")},modifier=Modifier.fillMaxWidth());OutlinedTextField(phone,{phone=it},label={Text("Provider Phone")},modifier=Modifier.fillMaxWidth());Row(Modifier.horizontalScroll(rememberScrollState())){listOf("CASH ON DELIVERY (COD)","CASH","BANK TRANSFER","MOBILE MONEY","NET 7","NET 30").forEach{x->FilterChip(terms==x,{terms=x},label={Text(x)},modifier=Modifier.padding(end=4.dp))}};Button({vm.addInvoice(Invoice(date=date,customer=o.customerName,customerId=o.customerId,phone=o.customerPhone,location=o.customerLocation,terms=terms,providerPhone=phone,items=o.items),o.id){done()}},modifier=Modifier.fillMaxWidth()){Text("Generate & Save Invoice")}}
}
@Composable private fun Invoices(s:UiState){val ctx=LocalContext.current;LazyColumn(Modifier.fillMaxSize().padding(12.dp),verticalArrangement=Arrangement.spacedBy(8.dp)){item{Text("Invoices",fontSize=23.sp,fontWeight=FontWeight.Bold,color=Forest)};items(s.invoices){i->Card{Column(Modifier.padding(13.dp)){Row(Modifier.fillMaxWidth(),horizontalArrangement=Arrangement.SpaceBetween){Text(i.invoiceNo,fontWeight=FontWeight.Bold);Text(mwk(i.grandTotal),fontWeight=FontWeight.Bold,color=Forest)};Text(i.customer);Text("${i.date} • ${i.location}",fontSize=12.sp,color=Muted);Button({sharePdf(ctx,i)}){Text("Share PDF")}}}}}}
@Composable private fun Customers(s:UiState,vm:AppViewModel){var add by remember{mutableStateOf(false)};if(add)CustomerForm(vm){add=false}else LazyColumn(Modifier.fillMaxSize().padding(12.dp),verticalArrangement=Arrangement.spacedBy(8.dp)){item{Row(Modifier.fillMaxWidth(),horizontalArrangement=Arrangement.SpaceBetween){Text("Customers",fontSize=23.sp,fontWeight=FontWeight.Bold,color=Forest);Button({add=true}){Text("Add")}}};items(s.customers.filter{it.active}){c->Card{Column(Modifier.padding(13.dp)){Text(c.name,fontWeight=FontWeight.Bold);Text(c.phone);Text(c.location,color=Muted)}}}}}
@Composable private fun CustomerForm(vm:AppViewModel,done:()->Unit){var n by remember{mutableStateOf("")};var p by remember{mutableStateOf("")};var l by remember{mutableStateOf("")};Form("Add Customer",done){Field("Customer Name",n){n=it};Field("Phone",p){p=it};Field("Location",l){l=it};Button({vm.addCustomer(Customer(name=n,phone=normalizePhone(p),location=l,assignedDay="Mon"));done()}){Text("Save Customer")}}}
@Composable
private fun Products(
    s: UiState,
    vm: AppViewModel
) {
    var add by remember { mutableStateOf(false) }

    if (add) {
        ProductForm(vm) {
            add = false
        }
    } else {
        LazyColumn(
            modifier = Modifier
                .fillMaxSize()
                .padding(12.dp),
            verticalArrangement = Arrangement.spacedBy(8.dp)
        ) {
            item {
                Row(
                    modifier = Modifier.fillMaxWidth(),
                    horizontalArrangement = Arrangement.SpaceBetween,
                    verticalAlignment = Alignment.CenterVertically
                ) {
                    Text(
                        text = "Products",
                        fontSize = 23.sp,
                        fontWeight = FontWeight.Bold,
                        color = Forest
                    )

                    if (s.role == "manager") {
                        Button(onClick = { add = true }) {
                            Text("Add")
                        }
                    }
                }
            }

            items(s.products) { product ->
                Card(
                    modifier = Modifier.fillMaxWidth()
                ) {
                    Column(
                        modifier = Modifier.padding(13.dp)
                    ) {
                        Text(
                            text = product.productName,
                            fontWeight = FontWeight.Bold
                        )
                        Text(
                            text = "${product.packLabel} • Qty ${product.quantity}",
                            fontSize = 12.sp
                        )
                        Text(text = "Price ${mwk(product.price)}")
                        Text(
                            text = "Stock ${product.stockOnHand}",
                            fontWeight = FontWeight.Bold,
                            color = if (product.stockOnHand <= 0) {
                                MaterialTheme.colorScheme.error
                            } else {
                                Forest2
                            }
                        )
                    }
                }
            }

            if (s.products.isEmpty()) {
                item {
                    Text(
                        text = "No products yet.",
                        modifier = Modifier.padding(24.dp),
                        color = Muted
                    )
                }
            }
        }
    }
}

@Composable private fun ProductForm(vm:AppViewModel,done:()->Unit){var n by remember{mutableStateOf("")};var pack by remember{mutableStateOf("")};var q by remember{mutableStateOf("")};var price by remember{mutableStateOf("")};Form("Add Product",done){Field("Product Name",n){n=it};Field("Pack",pack){pack=it};Field("Pack Quantity",q){q=it};Field("Price",price){price=it};Button({vm.addProduct(Product(productName=n,packLabel=pack,quantity=q.toDoubleOrNull()?:1.0,price=price.toDoubleOrNull()?:0.0));done()}){Text("Add to Catalog")}}}
@Composable
private fun Expenses(
    s: UiState,
    vm: AppViewModel
) {
    var add by remember { mutableStateOf(false) }

    if (add) {
        ExpenseForm(vm) {
            add = false
        }
    } else {
        LazyColumn(
            modifier = Modifier
                .fillMaxSize()
                .padding(12.dp),
            verticalArrangement = Arrangement.spacedBy(8.dp)
        ) {
            item {
                Row(
                    modifier = Modifier.fillMaxWidth(),
                    horizontalArrangement = Arrangement.SpaceBetween,
                    verticalAlignment = Alignment.CenterVertically
                ) {
                    Text(
                        text = "Expenses",
                        fontSize = 23.sp,
                        fontWeight = FontWeight.Bold,
                        color = Forest
                    )

                    Button(onClick = { add = true }) {
                        Text("Log Expense")
                    }
                }
            }

            item {
                Text(
                    text = "Loaded total: ${mwk(s.expenses.sumOf { it.amount })}",
                    fontWeight = FontWeight.Bold,
                    color = Forest
                )
            }

            items(s.expenses) { expense ->
                Card(
                    modifier = Modifier.fillMaxWidth()
                ) {
                    Column(
                        modifier = Modifier.padding(13.dp)
                    ) {
                        Row(
                            modifier = Modifier.fillMaxWidth(),
                            horizontalArrangement = Arrangement.SpaceBetween
                        ) {
                            Text(
                                text = expense.category,
                                fontWeight = FontWeight.Bold
                            )
                            Text(
                                text = mwk(expense.amount),
                                fontWeight = FontWeight.Bold
                            )
                        }

                        Text(
                            text = "${expense.date} • ${expense.notes}",
                            fontSize = 12.sp,
                            color = Muted
                        )
                    }
                }
            }

            if (s.expenses.isEmpty()) {
                item {
                    Text(
                        text = "No expenses yet.",
                        modifier = Modifier.padding(24.dp),
                        color = Muted
                    )
                }
            }
        }
    }
}

@Composable private fun ExpenseForm(vm:AppViewModel,done:()->Unit){var a by remember{mutableStateOf("")};var n by remember{mutableStateOf("")};var c by remember{mutableStateOf("Transport")};Form("Log New Expense",done){Row(Modifier.horizontalScroll(rememberScrollState())){listOf("Transport","Meals","Fuel","Stock Purchase","Other").forEach{x->FilterChip(c==x,{c=x},label={Text(x)},modifier=Modifier.padding(end=4.dp))}};Field("Amount (MWK)",a){a=it};Field("Notes",n){n=it};Button({vm.addExpense(Expense(date=nowDate(),category=c,amount=a.toDoubleOrNull()?:0.0,notes=n));done()}){Text("Log Expense")}}}
@Composable
private fun VisitLog(s: UiState, vm: AppViewModel) {
    var customer by remember { mutableStateOf<Customer?>(null) }
    var outcome by remember { mutableStateOf("Order Placed") }
    var reason by remember { mutableStateOf("") }
    var notes by remember { mutableStateOf("") }
    var qty by remember { mutableStateOf("1") }
    val cart = remember { mutableStateListOf<LineItem>() }

    LazyColumn(
        Modifier.fillMaxSize().padding(12.dp),
        verticalArrangement = Arrangement.spacedBy(8.dp)
    ) {
        item {
            Text(
                "Log Visit",
                fontSize = 23.sp,
                fontWeight = FontWeight.Bold,
                color = Forest
            )
        }

        items(s.customers.filter { it.active }) { cst ->
            Card(
                Modifier.fillMaxWidth().clickable { customer = cst }
            ) {
                Row(
                    Modifier.padding(13.dp),
                    horizontalArrangement = Arrangement.SpaceBetween
                ) {
                    Text(cst.name)
                    if (customer?.id == cst.id) {
                        Text("Selected", color = Forest2)
                    }
                }
            }
        }

        customer?.let { cst ->
            item {
                Card {
                    Column(
                        Modifier.padding(13.dp),
                        verticalArrangement = Arrangement.spacedBy(8.dp)
                    ) {
                        Row {
                            FilterChip(
                                selected = outcome == "Order Placed",
                                onClick = { outcome = "Order Placed" },
                                label = { Text("Order Placed") }
                            )
                            Spacer(Modifier.width(8.dp))
                            FilterChip(
                                selected = outcome == "No Order",
                                onClick = { outcome = "No Order" },
                                label = { Text("No Order") }
                            )
                        }

                        if (outcome == "No Order") {
                            Field("Reason", reason) { reason = it }
                            Field("Notes", notes) { notes = it }
                        } else {
                            Text(
                                "Quick add products",
                                fontWeight = FontWeight.Bold,
                                color = Forest
                            )

                            s.products.forEach { product ->
                                Button(
                                    onClick = {
                                        cart.add(
                                            LineItem(
                                                qty = qty.toDoubleOrNull() ?: 1.0,
                                                desc = "${product.productName} — ${product.packLabel}",
                                                price = product.price,
                                                productName = product.productName,
                                                packLabel = product.packLabel,
                                                packQuantity = product.quantity,
                                                productId = product.id
                                            )
                                        )
                                    },
                                    modifier = Modifier.fillMaxWidth()
                                ) {
                                    Text(
                                        "${product.productName} • ${product.packLabel} — ${mwk(product.price)}"
                                    )
                                }
                            }

                            Field("Quantity", qty) { qty = it }

                            cart.forEachIndexed { index, item ->
                                Row(
                                    Modifier.fillMaxWidth(),
                                    horizontalArrangement = Arrangement.SpaceBetween
                                ) {
                                    Text("${item.qty} × ${item.desc}")
                                    Text(mwk(item.total))
                                    TextButton(onClick = { cart.removeAt(index) }) {
                                        Text("Remove")
                                    }
                                }
                            }

                            Field("Notes", notes) { notes = it }
                        }

                        Button(
                            onClick = {
                                if (outcome == "Order Placed" && cart.isNotEmpty()) {
                                    val order = Order(
                                        customerId = cst.id,
                                        customerName = cst.name,
                                        customerPhone = cst.phone,
                                        customerLocation = cst.location,
                                        items = cart.toList(),
                                        notes = notes
                                    )
                                    vm.submitOrder(order) {
                                        vm.addVisit(
                                            Visit(
                                                customerName = cst.name,
                                                outcome = "Order Placed"
                                            ),
                                            cst.id
                                        ) {
                                            customer = null
                                            cart.clear()
                                        }
                                    }
                                } else if (outcome == "No Order") {
                                    vm.addVisit(
                                        Visit(
                                            customerName = cst.name,
                                            outcome = "No Order",
                                            reason = reason,
                                            notes = notes
                                        ),
                                        cst.id
                                    ) {
                                        customer = null
                                    }
                                }
                            },
                            modifier = Modifier.fillMaxWidth()
                        ) {
                            Text(
                                if (outcome == "Order Placed") {
                                    "Submit Order & Log Visit"
                                } else {
                                    "Save Visit"
                                }
                            )
                        }
                    }
                }
            }
        }
    }
}

@Composable private fun Summary(s:UiState){LazyColumn(Modifier.fillMaxSize().padding(16.dp),verticalArrangement=Arrangement.spacedBy(10.dp)){item{Text("Business Summary",fontSize=24.sp,fontWeight=FontWeight.Bold,color=Forest)};item{Info("Invoice Revenue",mwk(s.invoices.sumOf{it.grandTotal}))};item{Info("Expenses",mwk(s.expenses.sumOf{it.amount}))};item{Info("Net Cashflow",mwk(s.invoices.sumOf{it.grandTotal}-s.expenses.sumOf{it.amount}))};item{Info("Orders","${s.orders.count{it.status=="Submitted"}} submitted • ${s.orders.count{it.status=="Approved"}} approved • ${s.orders.count{it.status=="Delivered"}} delivered")}}}
@Composable private fun Form(title:String,done:()->Unit,content:@Composable ColumnScope.()->Unit){LazyColumn(Modifier.fillMaxSize().padding(16.dp),verticalArrangement=Arrangement.spacedBy(9.dp)){item{Text(title,fontSize=23.sp,fontWeight=FontWeight.Bold,color=Forest)};item{Column(verticalArrangement=Arrangement.spacedBy(9.dp),content=content)};item{Button(done){Text("Cancel")}}}}
@Composable private fun Field(label:String,value:String,onValue:(String)->Unit){OutlinedTextField(value,onValue,label={Text(label)},modifier=Modifier.fillMaxWidth())}
@Composable private fun Status(s:String){Surface(color=when(s){"Approved"->Color(0xFFE2F0DC);"Submitted"->Color(0xFFFFF0D6);"Rejected","Cancelled"->Color(0xFFFFE4E0);else->Color(0xFFEAEAEA)},shape=RoundedCornerShape(18.dp)){Text(s,Modifier.padding(horizontal=8.dp,vertical=4.dp),fontSize=11.sp,fontWeight=FontWeight.Bold)}}
private fun sharePdf(context:Context,i:Invoice){val doc=PdfDocument();val page=doc.startPage(PdfDocument.PageInfo.Builder(595,842,1).create());val c=page.canvas;val p=Paint(Paint.ANTI_ALIAS_FLAG);p.color=android.graphics.Color.rgb(20,64,31);p.textSize=24f;p.isFakeBoldText=true;c.drawText("NAISI FOODS",40f,55f,p);p.textSize=13f;c.drawText("SALES INVOICE",40f,80f,p);p.textSize=11f;var y=115f;fun row(a:String,b:String){p.isFakeBoldText=true;c.drawText(a,40f,y,p);p.isFakeBoldText=false;c.drawText(b,150f,y,p);y+=22};row("Invoice No.",i.invoiceNo);row("Date",i.date);row("Customer",i.customer);row("Phone",i.phone);row("Location",i.location);row("Terms",i.terms);y+=12;p.isFakeBoldText=true;c.drawText("QTY",40f,y,p);c.drawText("DESCRIPTION",90f,y,p);c.drawText("TOTAL",470f,y,p);p.isFakeBoldText=false;y+=22;i.items.forEach{c.drawText(it.qty.toString(),40f,y,p);c.drawText(it.desc.take(45),90f,y,p);c.drawText(mwk(it.total),470f,y,p);y+=20};y+=20;p.isFakeBoldText=true;c.drawText("GRAND TOTAL",350f,y,p);c.drawText(mwk(i.grandTotal),470f,y,p);y+=45;p.isFakeBoldText=false;c.drawText("Customer Signature: ______________________________",40f,y,p);y+=35;c.drawText("Thank you for your business!",190f,y,p);doc.finishPage(page);val f=File(context.cacheDir,"${i.invoiceNo.replace("[^A-Za-z0-9_-]".toRegex(),"_")}.pdf");f.outputStream().use{doc.writeTo(it)};doc.close();val uri=FileProvider.getUriForFile(context,"${context.packageName}.fileprovider",f);val send=Intent(Intent.ACTION_SEND).apply{type="application/pdf";putExtra(Intent.EXTRA_STREAM,uri);addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)};context.startActivity(Intent.createChooser(send,"Share invoice"))}
