// The tools the agent model can call (names, descriptions and JSON schemas).
import type { ToolDef } from "../core/llm/types.js";

export const AGENT_TOOLS: ToolDef[] = [
  {
    name: "click",
    description: "Click an element from the snapshot. Returns the updated page snapshot.",
    parameters: {
      type: "object",
      properties: {
        id: { type: "string", description: "Element id from the snapshot, e.g. \"12\" or \"3:12\" for elements inside a frame." },
        description: { type: "string", description: "Short human-readable description of what this click does, e.g. \"Open the application form\"." },
        final_action: { type: "boolean", description: "true if this click submits, sends, buys, books, posts, deletes, or is otherwise hard to undo. The user must approve these." }
      },
      required: ["id", "description", "final_action"]
    }
  },
  {
    name: "type",
    description: "Type text into a text field, replacing what's there unless clear is false. Returns the updated snapshot. Never use for passwords, payment, or ID numbers.",
    parameters: {
      type: "object",
      properties: {
        id: { type: "string" },
        text: { type: "string" },
        clear: { type: "boolean", description: "Replace existing text (default true)." }
      },
      required: ["id", "text"]
    }
  },
  {
    name: "select_option",
    description: "Choose an option in a dropdown, combobox or autocomplete (airports, cities, schools, companies) by what you want, e.g. \"Istanbul (IST)\". Sidekick opens it, types a code or name to filter if needed, and picks the closest match from the field's own list. Returns the updated snapshot.",
    parameters: {
      type: "object",
      properties: { id: { type: "string" }, option: { type: "string", description: "What to choose. Include a code when there is one (\"Washington Dulles (IAD)\")." } },
      required: ["id", "option"]
    }
  },
  {
    name: "pick_date",
    description: "Pick a date in a date field or calendar widget: opens it, moves to the right month, and clicks the day. Use for departure/return dates, deadlines, birthdays. Returns the updated snapshot.",
    parameters: {
      type: "object",
      properties: { id: { type: "string", description: "The date field or the button that opens the calendar." }, date: { type: "string", description: "YYYY-MM-DD" } },
      required: ["id", "date"]
    }
  },
  {
    name: "fill_fields",
    description: "Fill several form fields in ONE step: text boxes, dropdowns (native or custom), checkboxes, radio buttons, and the resume upload (value \"resume\"). Much faster than one action per field. For checkboxes and radios use \"true\" or \"false\". Returns one updated snapshot. Never for passwords, payment or ID numbers.",
    parameters: {
      type: "object",
      properties: {
        fields: {
          type: "array",
          items: { type: "object", properties: { id: { type: "string" }, value: { type: "string" } }, required: ["id", "value"] },
          description: "Fields in page order, e.g. [{\"id\": \"12\", \"value\": \"Ulugbek\"}, {\"id\": \"14\", \"value\": \"Pennsylvania\"}]"
        }
      },
      required: ["fields"]
    }
  },
  {
    name: "use_shortcut",
    description: "Run one of Sidekick's learned shortcuts for this site (listed in the snapshot with ids like s_ab12cd). It replays the routine steps that worked before (navigation, profile fields, resume upload) instantly, then stops when a step needs judgment (written answers, choices not in the profile, consent checkboxes) or before any final action. Continue from where it stopped.",
    parameters: { type: "object", properties: { shortcut_id: { type: "string" } }, required: ["shortcut_id"] }
  },
  {
    name: "site_tool",
    description: "Call a tool the website itself offers to AI agents (WebMCP), listed under \"This site offers tools\" in the snapshot. Faster and more reliable than clicking through the page. Tools not marked read-only need the user's approval.",
    parameters: {
      type: "object",
      properties: { name: { type: "string" }, arguments: { type: "object", description: "Arguments matching the tool's parameters." } },
      required: ["name"]
    }
  },
  {
    name: "set_checked",
    description: "Check or uncheck a checkbox, radio button, or switch. Returns the updated snapshot.",
    parameters: {
      type: "object",
      properties: { id: { type: "string" }, checked: { type: "boolean" } },
      required: ["id", "checked"]
    }
  },
  {
    name: "upload_file",
    description: "Attach the user's saved resume to a file-upload field (or the upload area around it). Returns the updated snapshot.",
    parameters: {
      type: "object",
      properties: { id: { type: "string" }, file: { type: "string", enum: ["resume"] } },
      required: ["id", "file"]
    }
  },
  {
    name: "press_key",
    description: "Press a key on an element (or the focused element). Useful for Enter in search boxes, Escape to close popups, arrows in menus.",
    parameters: {
      type: "object",
      properties: { key: { type: "string", enum: ["Enter", "Escape", "Tab", "ArrowDown", "ArrowUp", "Backspace", "Space"] }, id: { type: "string" } },
      required: ["key"]
    }
  },
  {
    name: "scroll",
    description: "Scroll the page (or a scrollable element) to reveal more content. Returns the updated snapshot.",
    parameters: {
      type: "object",
      properties: { direction: { type: "string", enum: ["down", "up", "top", "bottom", "all"], description: "\"all\" scrolls through the whole page once, so lists that load as you scroll (job boards, feeds) are complete in the next snapshot." }, id: { type: "string" } },
      required: ["direction"]
    }
  },
  {
    name: "find",
    description: "Search the whole page (every element and all text, including parts far below the screen and inside frames) for words, e.g. \"engineer\", \"apply\", \"sponsorship\". Returns matching elements with ids and matching text lines. Much faster than scrolling to look.",
    parameters: { type: "object", properties: { query: { type: "string", description: "Words to look for (case-insensitive)." } }, required: ["query"] }
  },
  {
    name: "web_search",
    description: "Search the web, e.g. to find a company's careers page or a job posting's application link, instead of guessing URLs.",
    parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"] }
  },
  {
    name: "plan",
    description: "Keep a checklist when the task has several parts (apply to 4 jobs, fill 3 forms). Call it first with all items, then again to update an item's status as you go. The user sees it.",
    parameters: {
      type: "object",
      properties: {
        items: { type: "array", items: { type: "string" }, description: "Set the whole list (first call)." },
        sites: { type: "array", items: { type: "string" }, description: "With items: every website (domain) the plan needs, e.g. [\"jobs.ashbyhq.com\"]. The user approves the plan with these sites; going elsewhere later needs their OK again." },
        update: { type: "object", properties: { item: { type: "number", description: "1-based" }, status: { type: "string", enum: ["doing", "done", "failed", "skipped"] }, note: { type: "string" } }, required: ["item", "status"] }
      }
    }
  },
  {
    name: "read_text",
    description: "Read the full text of the current page (for example a job description or article) when the snapshot's text preview isn't enough.",
    parameters: { type: "object", properties: {} }
  },
  {
    name: "screenshot",
    description: "See a screenshot of the visible part of the tab. Use when layout, images, or visual state matter, the snapshot is confusing, or something you need isn't in the element list (canvas apps, custom widgets, maps). The image's pixel coordinates are what click_at uses.",
    parameters: { type: "object", properties: {} }
  },
  {
    name: "zoom",
    description: "See part of the screen enlarged, to read small print: numbers on a graph's axes, a chart, a table or text inside an image, fine print. x, y, width, height are in the latest screenshot's pixels (take a screenshot first). Only for looking: click_at still uses the full screenshot's coordinates.",
    parameters: {
      type: "object",
      properties: { x: { type: "number" }, y: { type: "number" }, width: { type: "number" }, height: { type: "number" }, description: { type: "string", description: "What you want to read there." } },
      required: ["x", "y", "width", "height"]
    }
  },
  {
    name: "click_at",
    description: "Click at a point in the latest screenshot (x, y in that image's pixels). Use only when the element isn't in the snapshot list; prefer click with an id.",
    parameters: {
      type: "object",
      properties: {
        x: { type: "number" },
        y: { type: "number" },
        description: { type: "string", description: "What you're clicking and why." },
        final_action: { type: "boolean", description: "true if this submits, sends, buys, posts, deletes or is hard to undo." }
      },
      required: ["x", "y", "description", "final_action"]
    }
  },
  {
    name: "navigate",
    description: "Go to a URL in the current tab.",
    parameters: { type: "object", properties: { url: { type: "string" } }, required: ["url"] }
  },
  { name: "go_back", description: "Go back to the previous page in this tab.", parameters: { type: "object", properties: {} } },
  {
    name: "open_tab",
    description: "Open a URL in a new tab and continue working there.",
    parameters: { type: "object", properties: { url: { type: "string" } }, required: ["url"] }
  },
  { name: "list_tabs", description: "List open tabs in this window.", parameters: { type: "object", properties: {} } },
  {
    name: "switch_tab",
    description: "Continue working in another open tab.",
    parameters: { type: "object", properties: { tab_id: { type: "number" } }, required: ["tab_id"] }
  },
  {
    name: "wait",
    description: "Wait for the page to finish loading or updating, then return a new snapshot.",
    parameters: { type: "object", properties: { seconds: { type: "number", description: "1-10" } }, required: ["seconds"] }
  },
  {
    name: "ask_user",
    description: "Ask the user a question and wait for their answer. Use for missing information, decisions, sign-ins, passwords, CAPTCHAs, or anything you shouldn't guess. Ask all missing questions at once.",
    parameters: { type: "object", properties: { question: { type: "string" } }, required: ["question"] }
  },
  {
    name: "log_application",
    description: "Record a job application in the user's applications list. Call once after an application is successfully submitted (confirmation page shown).",
    parameters: {
      type: "object",
      properties: {
        company: { type: "string" },
        role: { type: "string" },
        status: { type: "string", enum: ["submitted", "draft"] },
        notes: { type: "string", description: "Anything worth remembering, e.g. answers that needed the user's input." }
      },
      required: ["company", "role", "status"]
    }
  },
  {
    name: "done",
    description: "Finish the task and report to the user.",
    parameters: {
      type: "object",
      properties: { summary: { type: "string", description: "What you did and the result, in Markdown. Mention anything the user still needs to do." } },
      required: ["summary"]
    }
  }
];
