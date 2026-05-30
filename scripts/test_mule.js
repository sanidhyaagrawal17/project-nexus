const id = '6a19a115ebb203e1640aafc3';
(async()=>{
  const res = await fetch(`http://localhost:5000/api/alerts/${id}/mule`, {
    method: 'PUT',
    headers: { 'Content-Type':'application/json', 'X-User-Role':'Analyst' },
    body: JSON.stringify({ muleStatus: 'Confirmed Mule' })
  });
  const txt = await res.text();
  console.log(res.status, txt);
})();
