document.addEventListener('DOMContentLoaded', () => {
    const recordForm = document.getElementById('recordForm');

    // Create device label and selector dynamically
    const deviceLabel = document.createElement('label');
    deviceLabel.textContent = 'Select device:';
    deviceLabel.style.display = 'block';
    deviceLabel.style.marginTop = '1rem';

    const deviceSelect = document.createElement('select');
    deviceSelect.name = 'device';
    deviceSelect.id = 'deviceSelect';
    deviceSelect.style.marginTop = '0.25rem';
    deviceSelect.style.marginBottom = '1rem';

    const devices = [
        { name: 'Desktop (Default)', value: 'desktop' },
        { name: 'iPhone 11', value: 'iPhone 11' },
        { name: 'Samsung Galaxy S9', value: 'Samsung Galaxy S9' },
        { name: 'iPad', value: 'iPad' },
        // Add more devices here if needed
    ];

    devices.forEach(d => {
        const option = document.createElement('option');
        option.value = d.value;
        option.textContent = d.name;
        deviceSelect.appendChild(option);
    });

    recordForm.insertBefore(deviceLabel, recordForm.querySelector('button'));
    recordForm.insertBefore(deviceSelect, recordForm.querySelector('button'));

    const recordMessage = document.getElementById('recordMessage');
    const submitBtn = document.getElementById('submitBtn');

    recordForm.addEventListener('submit', async function (event) {
        event.preventDefault();

        const urlInput = this.url;
        const testNameInput = this.testName;
        const device = deviceSelect.value;

        const url = urlInput.value.trim();
        const testName = testNameInput.value.trim();

        if (!url || !testName) {
            alert('Please fill in both URL and Test Name.');
            return;
        }

        submitBtn.disabled = true;

        urlInput.value = '';
        testNameInput.value = '';

        recordMessage.textContent = `Recording started for test "${testName}" on device "${device}"`;

        const intervalId = setInterval(async () => {
            try {
                const res = await fetch(`/recording-status/${encodeURIComponent(testName)}`);
                const data = await res.json();

                if (data.status !== 'running') {
                    recordMessage.textContent = '';
                    clearInterval(intervalId);
                    location.reload();
                }
            } catch {
                // ignore errors silently
            }
        }, 3000);

        try {
            await fetch('/record', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ url, testName, device }),
            });
        } catch (err) {
            alert('Failed to start recording. Please try again.');
            recordMessage.textContent = '';
            clearInterval(intervalId);
            submitBtn.disabled = false;
        }
    });

    // Existing code for listing tests remains unchanged
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
                        <strong>${t.name}</strong> <span style="color:#666;">(${t.device})</span><br/>
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