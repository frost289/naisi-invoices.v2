package com.frost289.naisiinvoices
import java.text.NumberFormat
import java.util.Locale
fun mwk(v:Double)="MWK "+NumberFormat.getNumberInstance(Locale.US).apply{minimumFractionDigits=2;maximumFractionDigits=2}.format(v)
fun normalizeText(s:String)=s.trim().replace(Regex("\\s+")," ").split(" ").filter{it.isNotEmpty()}.joinToString(" "){it.lowercase(Locale.getDefault()).replaceFirstChar{c->c.uppercase()}}
fun normalizePhone(raw:String):String{val d=raw.filter(Char::isDigit);val l=when{d.length==10&&d.startsWith("0")->d.drop(1);d.length==12&&d.startsWith("265")->d.drop(3);d.length==9->d;else->return ""};return if(l.length==9)"+265$l" else ""}
fun nowDate()=java.text.SimpleDateFormat("yyyy-MM-dd",Locale.US).format(java.util.Date())
fun invoiceNo(prefix:String,n:Long)="$prefix-${java.util.Calendar.getInstance().get(java.util.Calendar.YEAR)}-${n.toString().padStart(4,'0')}"
