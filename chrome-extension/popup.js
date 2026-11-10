const HELP_DESK_URL = "https://helpdesk.avada.net";
const GROUPS = [
  { key: "pending", label: "Pending", action: { label: "Move to doing", nextStatus: "doing" } },
  { key: "doing", label: "Doing", action: { label: "Wait customer", nextStatus: "waiting_customer" }, moveAll: true },
  // Waiting Customer is read-only in the popup. It includes every open
  // waiting_customer ticket where Andrew is assigned, even when it also has
  // CS/other TS members (the queue is not limited to Andrew-only tickets).
  { key: "waiting_customer", label: "Waiting customer", showDetails: true },
  { key: "dev_fixing", label: "Dev fix", slackOnly: true },
  { key: "feature_request", label: "Feature", slackOnly: true },
];

const ticketsView = document.querySelector("#tickets-view");
const settingsView = document.querySelector("#settings-view");
const categoryList = document.querySelector("#category-list");
const totalCount = document.querySelector("#total-count");
const lastUpdated = document.querySelector("#last-updated");
const statusMessage = document.querySelector("#status-message");
const refreshButton = document.querySelector("#refresh-button");
const apiKeyInput = document.querySelector("#api-key");
const widgetDisplay = document.querySelector("#widget-display");
const widgetPosition = document.querySelector("#widget-position");
const apiKeyStatus = document.querySelector("#api-key-status");
const apiKeyDetails = document.querySelector("#api-key-details");
const settingsError = document.querySelector("#settings-error");

function request(message) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(message, (response) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
      } else if (!response?.ok) {
        reject(new Error(response?.error || "Extension request failed."));
      } else {
        resolve(response);
      }
    });
  });
}

function getSettings() {
  return chrome.storage.local.get({
    apiKey: "",
    widgetDisplay: "panel",
    widgetPosition: "bottom-right",
  });
}

function setStatus(message = "", isError = false) {
  statusMessage.textContent = message;
  statusMessage.classList.toggle("error", isError);
}

async function showSettings() {
  ticketsView.hidden = true;
  settingsView.hidden = false;
  const settings = await getSettings();
  apiKeyInput.value = "";
  widgetDisplay.value = settings.widgetDisplay === "bubble" ? "bubble" : "panel";
  widgetPosition.value = settings.widgetPosition === "bottom-left" ? "bottom-left" : "bottom-right";
  apiKeyStatus.textContent = settings.apiKey
    ? "API key is saved in this Chrome profile and will load automatically."
    : "No API key is saved yet. Add one below to connect Helpdesk.";
  apiKeyDetails.open = !settings.apiKey;
  if (!settings.apiKey) apiKeyInput.focus();
}

function showTickets() {
  settingsView.hidden = true;
  ticketsView.hidden = false;
}

function ticketUrl(ticket) {
  return `${HELP_DESK_URL}/t/${encodeURIComponent(ticket.ticketId || ticket.id)}`;
}

function ticketMemberSummary(ticket) {
  const members = Array.isArray(ticket.members) ? ticket.members : [];
  const memberIds = Array.isArray(ticket.memberIds) ? ticket.memberIds : [];
  const count = members.length || memberIds.length;
  const names = members
    .map((member) => member?.displayName || member?.name || member?.email || member?.memberId || member?.id)
    .filter(Boolean);
  const label = `${count} member${count === 1 ? "" : "s"}`;
  return names.length ? `${label}: ${names.join(", ")}` : label;
}

function createTicketRow(ticket, group) {
  const row = document.createElement("div");
  row.className = "ticket-row";
  const destination = group.slackOnly ? ticket.slackLink : ticketUrl(ticket);

  if (destination) {
    const link = document.createElement("a");
    link.className = "ticket-link";
    link.href = destination;
    link.target = "_blank";
    link.rel = "noreferrer";
    const id = document.createElement("span");
    id.className = "ticket-id";
    id.textContent = ticket.ticketId || ticket.id;
    const subject = document.createElement("span");
    subject.className = "ticket-subject";
    subject.textContent = ticket.subject || "No subject";
    link.append(id, subject);
    if (group.showDetails) {
      const members = document.createElement("span");
      members.className = "ticket-members";
      members.textContent = ticketMemberSummary(ticket);
      const description = document.createElement("span");
      description.className = "ticket-description";
      description.textContent = ticket.description || "No description";
      link.append(members, description);
    }
    row.append(link);
  } else {
    const noLink = document.createElement("span");
    noLink.className = "no-link";
    noLink.textContent = `${ticket.ticketId || ticket.id}: no Slack link`;
    row.append(noLink);
  }

  if (group.action) {
    const action = document.createElement("button");
    action.className = "ticket-move";
    action.type = "button";
    action.textContent = group.action.label;
    action.addEventListener("click", async () => {
      action.disabled = true;
      try {
        await request({ type: "move-ticket", ticket, nextStatus: group.action.nextStatus });
        await loadTickets();
      } catch (error) {
        setStatus(error.message, true);
      } finally {
        action.disabled = false;
      }
    });
    row.append(action);
  }
  return row;
}

function createCategory(group, tickets) {
  const category = document.createElement("section");
  category.className = "category";
  const header = document.createElement("div");
  header.className = "category-header";
  const toggle = document.createElement("button");
  toggle.className = "category-toggle";
  toggle.type = "button";
  toggle.innerHTML = '<span class="chevron">›</span>';
  const label = document.createElement("span");
  label.className = "category-name";
  label.textContent = group.label;
  const count = document.createElement("span");
  count.className = "category-count";
  count.textContent = String(tickets.length);
  toggle.append(label, count);
  toggle.addEventListener("click", () => category.classList.toggle("expanded"));
  header.append(toggle);

  if (group.moveAll && tickets.length) {
    const moveAll = document.createElement("button");
    moveAll.className = "move-button secondary";
    moveAll.type = "button";
    moveAll.textContent = "Move all → wait";
    moveAll.addEventListener("click", async () => {
      moveAll.disabled = true;
      try {
        const result = await request({ type: "move-all-status", status: group.key, nextStatus: group.action.nextStatus });
        const failure = result.failed?.length ? ` ${result.failed.length} failed.` : "";
        setStatus(`Moved ${result.moved} ticket(s) to waiting_customer.${failure}`, Boolean(result.failed?.length));
        await loadTickets();
      } catch (error) {
        setStatus(error.message, true);
      } finally {
        moveAll.disabled = false;
      }
    });
    header.append(moveAll);
  }

  const panel = document.createElement("div");
  panel.className = "category-panel";
  if (!tickets.length) {
    const empty = document.createElement("p");
    empty.className = "empty-state";
    empty.textContent = `No ${group.label.toLowerCase()} tickets.`;
    panel.append(empty);
  } else {
    tickets.forEach((ticket) => panel.append(createTicketRow(ticket, group)));
  }
  category.append(header, panel);
  return category;
}

function renderGroups(groups) {
  categoryList.replaceChildren();
  const total = GROUPS.reduce((sum, group) => sum + (groups[group.key] || []).length, 0);
  totalCount.textContent = `${total} ticket${total === 1 ? "" : "s"}`;
  GROUPS.forEach((group) => categoryList.append(createCategory(group, groups[group.key] || [])));
}

async function loadTickets() {
  const settings = await getSettings();
  const { apiKey } = settings;
  if (!apiKey) {
    await showSettings();
    return;
  }
  refreshButton.disabled = true;
  totalCount.textContent = "Loading…";
  setStatus("Fetching Andrew's tickets…");
  try {
    const { groups } = await request({ type: "get-ticket-groups" });
    renderGroups(groups);
    setStatus("");
    lastUpdated.textContent = `Updated ${new Date().toLocaleTimeString()}`;
  } catch (error) {
    totalCount.textContent = "Unable to load";
    setStatus(`Could not load tickets: ${error.message}`, true);
  } finally {
    refreshButton.disabled = false;
  }
}

document.querySelector("#settings-button").addEventListener("click", showSettings);
document.querySelector("#back-button").addEventListener("click", async () => {
  showTickets();
  await loadTickets();
});
refreshButton.addEventListener("click", loadTickets);
document.querySelector("#save-button").addEventListener("click", async () => {
  const existing = await getSettings();
  const apiKey = apiKeyInput.value.trim() || existing.apiKey;
  if (!apiKey) {
    settingsError.textContent = "Please add an API key once to connect Helpdesk.";
    return;
  }
  const settings = {
    apiKey,
    widgetDisplay: widgetDisplay.value,
    widgetPosition: widgetPosition.value,
  };
  await chrome.storage.local.set(settings);
  settingsError.textContent = "";
  showTickets();
  await loadTickets();
});
document.querySelector("#widget-button").addEventListener("click", async () => {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) throw new Error("No active browser tab.");
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["widget.js"] });
    window.close();
  } catch (error) {
    setStatus(`Could not show widget: ${error.message}`, true);
  }
});

loadTickets();
