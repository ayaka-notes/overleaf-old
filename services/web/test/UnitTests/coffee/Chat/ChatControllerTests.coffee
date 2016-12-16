should = require('chai').should()
SandboxedModule = require('sandboxed-module')
assert = require('assert')
path = require('path')
sinon = require('sinon')
modulePath = path.join __dirname, "../../../../app/js/Features/Chat/ChatController"
expect = require("chai").expect

describe "ChatController", ->
	beforeEach ->
		@user_id = 'mock-user-id'
		@settings = {}
		@ChatApiHandler = {}
		@EditorRealTimeController =
			emitToRoom:sinon.stub().callsArgWith(3)
		@AuthenticationController =
			getLoggedInUserId: sinon.stub().returns(@user_id)
		@ChatController = SandboxedModule.require modulePath, requires:
			"settings-sharelatex": @settings
			"logger-sharelatex": log: ->
			"./ChatApiHandler": @ChatApiHandler
			"../Editor/EditorRealTimeController": @EditorRealTimeController
			'../Authentication/AuthenticationController': @AuthenticationController
		@req =
			params:
				project_id: @project_id
		@res =
			json: sinon.stub()
			send: sinon.stub()

	describe "sendMessage", ->
		beforeEach ->
			@req.body =
				content: @content = "message-content"
			@ChatApiHandler.sendGlobalMessage = sinon.stub().yields(null, @message = {"mock": "message"})
			@ChatController.sendMessage @req, @res

		it "should tell the chat handler about the message", ->
			@ChatApiHandler.sendGlobalMessage
				.calledWith(@project_id, @user_id, @content)
				.should.equal true

		it "should tell the editor real time controller about the update with the data from the chat handler", ->
			@EditorRealTimeController.emitToRoom
				.calledWith(@project_id, "new-chat-message", @message)
				.should.equal true
				
		it "should return a 204 status code", ->
			@res.send.calledWith(204).should.equal true

	describe "getMessages", ->
		beforeEach ->
			@req.query =
				limit: @limit = "30"
				before: @before = "12345"
			@ChatApiHandler.getGlobalMessages = sinon.stub().yields(null, @messages = ["mock", "messages"])
			@ChatController.getMessages @req, @res

		it "should ask the chat handler about the request", ->
			@ChatApiHandler.getGlobalMessages
				.calledWith(@project_id, @limit, @before)
				.should.equal true

		it "should return the messages", ->
			@res.json.calledWith(@messages).should.equal true