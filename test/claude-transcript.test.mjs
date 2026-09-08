import test from "node:test";
import assert from "node:assert/strict";
import { ClaudeTranscriptTracker, claudeSubagentActivities } from "../dist/adapters/claude.js";
const payload=(type,content)=>({type,message:{content}});
test("ordinary Bash calls have paired tool activity and never become subagents",()=>{
 const tracker=new ClaudeTranscriptTracker();
 const start=payload("assistant",[{type:"tool_use",id:"tool-1",name:"Bash",input:{command:"cat fixture.txt"}}]);
 const end=payload("user",[{type:"tool_result",tool_use_id:"tool-1",content:"marker"}]);
 assert.equal(tracker.activities(start)[0].phase,"started");
 const result=tracker.activities(end)[0];
 assert.equal(result.phase,"completed"); assert.equal(result.tool,"Bash"); assert.equal(result.output,"marker");
 assert.equal(result.agentID,undefined); assert.deepEqual(claudeSubagentActivities(end,new Map()),[]);
 assert.deepEqual(tracker.activities(end),[]);
});
test("actual Agent calls retain their identity and failures",()=>{
 const labels=new Map();
 claudeSubagentActivities(payload("assistant",[{type:"tool_use",id:"agent-1",name:"Agent",input:{description:"Review"}}]),labels);
 const events=claudeSubagentActivities(payload("user",[{type:"tool_result",tool_use_id:"agent-1",is_error:true,content:"failed"}]),labels);
 assert.equal(events[0].agentID,"agent-1");assert.equal(events[0].result,"Failed");
});
test("message identities separate narration from the answer and isolate subagents",()=>{
 const tracker=new ClaudeTranscriptTracker();
 const start=(id,parent)=>({type:"stream_event",...(parent?{parent_tool_use_id:parent}:{}),event:{type:"message_start",message:{id}}});
 assert.equal(tracker.messageID(start("narration")),"narration");
 assert.equal(tracker.messageID(start("child","agent-1")),"child");
 assert.equal(tracker.messageID({type:"stream_event",event:{type:"content_block_delta"}}),"narration");
 assert.equal(tracker.messageID(start("answer")),"answer");
});
