document.addEventListener('DOMContentLoaded', () => {
    fetch('/tests')
        .then(res => res.json())
        .then(tests => {
            const container = document.getElementById('testList');
            if (tests.length === 0) {
                container.innerHTML = "<p>No saved tests found in /sessions.</p>";
                return;
            }

            const ul = document.createElement('ul');

            tests.forEach(t => {
                const li = document.createElement('li');
                li.innerHTML = `
                    <div>
                        <strong>${t.name}</strong><br/>
                        <a href="${t.href}" target="_blank" style="font-size: 0.9em; color: #666; text-decoration: underline;">${t.href}</a>
                    </div>
                    <div>
                        <span class="status" style="margin-right: 10px;"></span>
                        <button class="run-btn" data-name="${t.name}">▶️ Run</button>
                        <button class="delete-btn" data-name="${t.name}">🗑️ Delete</button>
                    </div>
                `;
                ul.appendChild(li);

                const runBtn = li.querySelector('.run-btn');
                const statusSpan = li.querySelector('.status');
                const testName = t.name;

                // Show last run status and timestamp on page load
                fetch(`/status/${encodeURIComponent(testName)}`)
                    .then(res => res.json())
                    .then(data => {
                        if (data.status && data.status !== 'running' && data.timestamp) {
                            const dt = new Date(data.timestamp);
                            const pad = n => n.toString().padStart(2, '0');
                            const time = `${pad(dt.getHours())}:${pad(dt.getMinutes())}:${pad(dt.getSeconds())}`;
                            const date = `${dt.getFullYear()}-${pad(dt.getMonth() + 1)}-${pad(dt.getDate())}`;

                            const emoji =
                                data.status === 'done' ? '✅ Success' :
                                    data.status === 'failed' ? '❌ Failed' : '';
                            if (emoji) {
                                statusSpan.textContent = `${emoji} (${time} ${date})`;
                            }
                        }
                    })
                    .catch(() => {
                        statusSpan.textContent = '';
                    });

                runBtn.addEventListener('click', async () => {
                    runBtn.disabled = true;
                    const originalText = runBtn.innerHTML;
                    runBtn.innerHTML = '⏳ Running...';
                    statusSpan.textContent = '';

                    try {
                        const res = await fetch(`/run/${encodeURIComponent(testName)}`);
                        const json = await res.json();
                        if (json.status === 'started') {
                            const poll = setInterval(async () => {
                                try {
                                    const statusRes = await fetch(`/status/${encodeURIComponent(testName)}`);
                                    const statusData = await statusRes.json();
                                    if (statusData.status === 'done' || statusData.status === 'failed') {
                                        const dt = new Date(statusData.timestamp);
                                        const pad = n => n.toString().padStart(2, '0');
                                        const time = `${pad(dt.getHours())}:${pad(dt.getMinutes())}:${pad(dt.getSeconds())}`;
                                        const date = `${dt.getFullYear()}-${pad(dt.getMonth() + 1)}-${pad(dt.getDate())}`;

                                        statusSpan.textContent =
                                            statusData.status === 'done'
                                                ? `✅ Success (${time} ${date})`
                                                : `❌ Failed (${time} ${date})`;

                                        runBtn.innerHTML = originalText;
                                        runBtn.disabled = false;
                                        clearInterval(poll);
                                    }
                                } catch {
                                    // ignore polling errors silently
                                }
                            }, 2000);
                        } else {
                            runBtn.innerHTML = originalText;
                            runBtn.disabled = false;
                            statusSpan.textContent = '❌ Failed to start';
                        }
                    } catch (err) {
                        runBtn.innerHTML = originalText;
                        runBtn.disabled = false;
                        statusSpan.textContent = '❌ Error';
                    }
                });

                const deleteBtn = li.querySelector('.delete-btn');
                deleteBtn.addEventListener('click', async () => {
                    if (!confirm(`Delete test "${testName}"?`)) return;
                    try {
                        const res = await fetch(`/delete/${encodeURIComponent(testName)}`, { method: 'DELETE' });
                        if (res.ok) {
                            li.remove();
                        } else {
                            alert('Failed to delete test.');
                        }
                    } catch {
                        alert('Error deleting test.');
                    }
                });
            });

            container.appendChild(ul);
        });
});
