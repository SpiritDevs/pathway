//
//  inputValidators.swift
//  Pathway
//
//  Created by Corey Baines on 30/11/2024.
//

import Foundation

func isValidEmail(_ email: String) -> Bool {
    let emailRegex = "^[A-Z0-9._%+-]+@[A-Z0-9.-]+\\.[A-Z]{2,}$"
    let predicate = NSPredicate(format: "SELF MATCHES[c] %@", emailRegex)
    return predicate.evaluate(with: email)
}

func isValidPassword(_ password: String) -> Bool {
    let passwordRegex = "^(?=.*[A-Z])(?=.*[0-9])(?=.*[!@#$&*]).{8,}$"
    let predicate = NSPredicate(format: "SELF MATCHES %@", passwordRegex)
    return predicate.evaluate(with: password)
}
