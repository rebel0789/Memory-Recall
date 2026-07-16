Rails.application.routes.draw do
  get "/items/:id", to: "items#show"
end
