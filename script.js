const ideaForm = document.getElementById("ideaForm");
const ideaInput = document.getElementById("ideaInput");
const ideasList = document.getElementById("ideasList");
const statusMessage = document.getElementById("statusMessage");
const submitButton = document.getElementById("submitButton");
const NOTE_TOGGLE_THRESHOLD = 78;

const ratingClassByLabel = {
  "Dumb": "rating-dumb",
  "Meh": "rating-meh",
  "Kinda Good": "rating-kinda-good",
  "Really Good": "rating-really-good"
};
const ratingItemClassByLabel = {
  "Dumb": "item-dumb",
  "Meh": "item-meh",
  "Kinda Good": "item-kinda-good",
  "Really Good": "item-really-good"
};

function setStatus(message, isError = false) {
  statusMessage.textContent = message;
  statusMessage.classList.toggle("status-error", isError);
}

function renderIdea(idea, prepend = false) {
  const item = document.createElement("li");
  item.className = "idea-item";

  const contentWrap = document.createElement("div");
  contentWrap.className = "idea-content";

  const textNode = document.createElement("p");
  textNode.className = "idea-title";
  textNode.textContent = idea.idea_text;

  const noteNode = document.createElement("p");
  noteNode.className = "idea-note";
  const noteText = (idea.rating_note || "").trim();
  noteNode.textContent = noteText;

  const badge = document.createElement("span");
  const ratingClass = ratingClassByLabel[idea.rating] || "rating-meh";
  badge.className = `rating-badge ${ratingClass}`;
  badge.textContent = idea.rating;
  item.classList.add(ratingItemClassByLabel[idea.rating] || "item-meh");

  contentWrap.appendChild(textNode);
  if (noteText.length > NOTE_TOGGLE_THRESHOLD) {
    noteNode.classList.add("is-collapsed");

    const noteWrap = document.createElement("div");
    noteWrap.className = "idea-note-wrap";

    const toggle = document.createElement("button");
    toggle.type = "button";
    toggle.className = "note-toggle";
    toggle.setAttribute("aria-expanded", "false");
    toggle.textContent = "▼";

    toggle.addEventListener("click", () => {
      const expanded = toggle.getAttribute("aria-expanded") === "true";
      toggle.setAttribute("aria-expanded", expanded ? "false" : "true");
      toggle.textContent = expanded ? "▼" : "▲";
      noteNode.classList.toggle("is-collapsed", expanded);
      noteNode.classList.toggle("is-expanded", !expanded);
    });

    noteWrap.appendChild(noteNode);
    noteWrap.appendChild(toggle);
    contentWrap.appendChild(noteWrap);
  } else {
    contentWrap.appendChild(noteNode);
  }
  item.appendChild(contentWrap);
  item.appendChild(badge);

  if (prepend) {
    ideasList.prepend(item);
    return;
  }

  ideasList.appendChild(item);
}

async function loadIdeas() {
  setStatus("Loading ideas...");

  try {
    const response = await fetch("/api/ideas");
    const data = await response.json();

    if (!response.ok) {
      throw new Error(data.error || "Could not load ideas.");
    }

    ideasList.innerHTML = "";
    data.ideas.forEach((idea) => renderIdea(idea));
    setStatus(data.ideas.length ? "" : "No ideas yet. Add the first one.");
  } catch (error) {
    setStatus(error.message || "Could not load ideas.", true);
  }
}

ideaForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const text = ideaInput.value.trim();

  if (!text) {
    ideaInput.focus();
    return;
  }

  submitButton.disabled = true;
  setStatus("Saving idea...");

  try {
    const response = await fetch("/api/ideas", {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ idea: text })
    });

    const data = await response.json();

    if (!response.ok) {
      throw new Error(data.error || "Could not save idea.");
    }

    renderIdea(data.idea, true);
    ideaInput.value = "";
    ideaInput.focus();
    setStatus("");
  } catch (error) {
    setStatus(error.message || "Could not save idea.", true);
  } finally {
    submitButton.disabled = false;
  }
});

loadIdeas();
