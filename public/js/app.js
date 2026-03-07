const socket = io()

let selectedBus="BUS1"

const map=L.map('map').setView([12.9716,77.5946],13)

L.tileLayer(
'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png'
).addTo(map)

let marker=null

const stops=[
{lat:12.9716,lng:77.5946,name:"College Gate"},
{lat:12.973,lng:77.597,name:"Main Stop"},
{lat:12.975,lng:77.600,name:"City Stop"}
]

stops.forEach(stop=>{
 L.marker([stop.lat,stop.lng]).addTo(map)
 .bindPopup(stop.name)
})

let route=[
[12.9716,77.5946],
[12.973,77.597],
[12.975,77.600]
]

L.polyline(route,{color:'blue'}).addTo(map)

const select=document.getElementById("busSelect")

for(let i=1;i<=8;i++){
 let op=document.createElement("option")
 op.value="BUS"+i
 op.text="BUS "+i
 select.appendChild(op)
}

select.onchange=function(){
 selectedBus=this.value
}

function distance(a,b,c,d){

let R=6371

let dLat=(c-a)*Math.PI/180
let dLon=(d-b)*Math.PI/180

let x=
Math.sin(dLat/2)**2+
Math.cos(a*Math.PI/180)*
Math.cos(c*Math.PI/180)*
Math.sin(dLon/2)**2

let y=2*Math.atan2(Math.sqrt(x),Math.sqrt(1-x))

return R*y

}

socket.on("busData",(buses)=>{

let bus=buses.find(b=>b.id===selectedBus)

if(!bus) return

if(bus.status==="running"){

 if(!marker){

  marker=L.marker([bus.lat,bus.lng]).addTo(map)

 }else{

  marker.setLatLng([bus.lat,bus.lng])

 }

 map.setView([bus.lat,bus.lng],15)

}

let d=distance(
 bus.lat,bus.lng,
 stops[0].lat,stops[0].lng
)

let eta=Math.round(d/0.5)

document.getElementById("cards").innerHTML=`

<div class="bus-card">

<h3>${bus.id}</h3>

<p>Status: ${bus.status==="running"?"🟢 Running":"🔴 Not Running"}</p>

<p>Distance to stop: ${d.toFixed(2)} km</p>

<p>ETA: ${eta} minutes</p>

</div>

`

})